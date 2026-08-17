import hashlib
import json
import re

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import escape_html, flt, getdate, now_datetime, nowtime


# ── Item Creator approval flow ──
# Default roles that may APPROVE an item-creation request (and self-create
# one-step). Stock ERPNext roles only — this app installs on any site, so it
# must never reference roles that do not ship with Frappe/ERPNext. Sites that
# want a different set configure it in TS Item Code Settings → approver_roles.
ITEM_APPROVER_ROLES = {"System Manager", "Item Manager", "Stock Manager"}
# Optional denylist of roles that may NOT submit item requests. Empty by
# default — a stock site has no floor-operator roles to exclude. Sites may
# extend this in a site-level customisation if they need it.
ITEM_REQUEST_FLOOR_ONLY = set()
# Generic baseline roles almost everyone carries — they don't signal desk-work
# authority, so they are ignored when deciding the denylist. DENYLIST semantics:
# a user may submit if they hold at least ONE role that is neither a denied role
# nor a baseline role — so any genuine functional role (incl. ones added later)
# is auto-included. The page role list is only the UX gate; this is the real
# security gate.
ITEM_REQUEST_BASELINE_ROLES = {"All", "Guest", "Employee", "Desk User"}

def _hsn_validation_active():
	"""True when this site will REJECT an Item that has no HSN/SAC code.

	india_compliance hooks Item.validate and, for sales items, throws
	MandatoryError when GST Settings → validate_hsn_code is on. Since
	ERPNext defaults is_sales_item to 1, every Item this app creates is
	affected. Without this check the failure surfaces late and confusingly,
	from deep inside the Item insert, after a code has already been minted.

	Deliberately fail-open: on a site without india_compliance (this app is
	installed on non-Indian sites too) this returns False and HSN stays
	optional.
	"""
	try:
		if "india_compliance" not in frappe.get_installed_apps():
			return False
		from india_compliance.gst_india.utils import get_hsn_settings

		validate_hsn, _lengths = get_hsn_settings()
		return bool(validate_hsn)
	except Exception:
		return False


# Hard cap on the rows pulled into the in-memory fuzzy (difflib) duplicate scan.
# Keeps search_existing_items bounded on sites with very large item masters.
FUZZY_SCAN_CAP = 2000


def _reject_guest():
	"""Light auth guard for the read-only whitelisted helpers below.

	These endpoints are called by the Item Creator page as a normal logged-in
	desk user; they must never be reachable anonymously.
	"""
	if frappe.session.user in ("Guest", "", None):
		raise frappe.PermissionError(_("Not permitted."))


def _get_role_users(role):
	"""Get all active users with a specific role (batch query)."""
	return frappe.db.sql_list("""
		SELECT DISTINCT hr.parent
		FROM `tabHas Role` hr
		INNER JOIN `tabUser` u ON u.name = hr.parent
		WHERE hr.role = %s
			AND hr.parenttype = 'User'
			AND u.enabled = 1
			AND hr.parent != 'Administrator'
	""", role)


def _get_approver_roles():
	"""Return the effective approver role set.

	Reads the optional comma-separated override from the TS Item Code Settings
	single (field ``approver_roles``). Falls back to ITEM_APPROVER_ROLES when the
	field is empty, missing (un-migrated site) or unreadable.
	"""
	try:
		raw = frappe.db.get_single_value("TS Item Code Settings", "approver_roles")
	except Exception:
		raw = None
	if raw:
		roles = {r.strip() for r in str(raw).split(",") if r and r.strip()}
		if roles:
			return roles
	return set(ITEM_APPROVER_ROLES)


def _approver_roles_label():
	"""Human-readable list of the effective approver roles, for error messages."""
	return ", ".join(sorted(_get_approver_roles()))


def _is_item_approver(user=None):
	"""True if the user may approve item requests / create Items directly."""
	user = user or frappe.session.user
	if user == "Administrator":
		return True
	return bool(set(frappe.get_roles(user)) & _get_approver_roles())


def _can_request_item(user=None):
	"""DENYLIST gate — True unless the user has only baseline / denied roles.

	Lets all desk staff submit an item-creation request while excluding Guest
	and any role listed in ITEM_REQUEST_FLOOR_ONLY. New roles auto-included.
	"""
	user = user or frappe.session.user
	if user in ("Guest", "", None):
		return False
	if user == "Administrator":
		return True
	# Strip baseline roles, then require at least one non-floor functional role.
	roles = set(frappe.get_roles(user)) - ITEM_REQUEST_BASELINE_ROLES
	return bool(roles - ITEM_REQUEST_FLOOR_ONLY)


def derive_fy_short(fiscal_year):
	"""Convert 'YYYY-YYYY' fiscal year name to short form 'YY-YY'.

	Falls back to year_start_date/year_end_date on the Fiscal Year doc if the
	name does not match the standard pattern.
	"""
	if not fiscal_year:
		return ""
	name = str(fiscal_year).strip()
	match = re.match(r"^(\d{4})-(\d{4})$", name)
	if match:
		return match.group(1)[-2:] + "-" + match.group(2)[-2:]
	# Handle 'FY 2025-2026' or similar
	match = re.search(r"(\d{4})\D+(\d{4})", name)
	if match:
		return match.group(1)[-2:] + "-" + match.group(2)[-2:]
	# Last resort: read dates from Fiscal Year DocType
	try:
		fy = frappe.db.get_value(
			"Fiscal Year", fiscal_year, ["year_start_date", "year_end_date"], as_dict=True
		)
		if fy and fy.year_start_date and fy.year_end_date:
			return str(fy.year_start_date.year)[-2:] + "-" + str(fy.year_end_date.year)[-2:]
	except Exception:
		pass
	return name


def _code_counter_row_name(company_key, category_key):
	"""Deterministic child-row name for a (company, category) counter.

	A deterministic PRIMARY KEY is what makes the INSERT below safe under
	concurrency: two racing transactions collide on the key instead of creating
	two counter rows for the same bucket.
	"""
	digest = hashlib.md5(
		("{0}\x1f{1}".format(company_key or "", category_key or "")).encode("utf-8")
	).hexdigest()
	return "icc-" + digest


def _insert_code_counter_row(company_key, category_key):
	"""Insert a zeroed TS Code Counter row for this bucket, directly in SQL.

	Deliberately does NOT go through the TS Item Code Settings Single document:
	saving that Single rewrites every counter row from an in-memory snapshot and
	can revert a concurrent transaction's raw UPDATE. ON DUPLICATE KEY UPDATE
	makes a lost race a no-op that still takes the row lock.
	"""
	row_name = _code_counter_row_name(company_key, category_key)
	next_idx = frappe.db.sql("""
		SELECT COALESCE(MAX(idx), 0) + 1 FROM `tabTS Code Counter`
		WHERE parent = 'TS Item Code Settings' AND parenttype = 'TS Item Code Settings'
	""")
	idx = (next_idx[0][0] if next_idx else 1) or 1
	user = frappe.session.user or "Administrator"

	frappe.db.sql("""
		INSERT INTO `tabTS Code Counter`
			(name, creation, modified, owner, modified_by, docstatus, idx,
			 parent, parenttype, parentfield,
			 company_code, category_code, last_serial)
		VALUES
			(%s, NOW(), NOW(), %s, %s, 0, %s,
			 'TS Item Code Settings', 'TS Item Code Settings', 'counters',
			 %s, %s, 0)
		ON DUPLICATE KEY UPDATE last_serial = last_serial
	""", (row_name, user, user, idx, company_key, category_key))

	frappe.clear_document_cache("TS Item Code Settings", "TS Item Code Settings")
	return row_name


def _ensure_fixed_asset_masters():
	"""Fail fast with a readable message when the Fixed Asset lane is unusable.

	The asset lane force-sets Item Group "Fixed Assets" and requires an Asset
	Category. Neither is guaranteed on a stock ERPNext site, and the raw link
	failure ("Could not find Item Group: Fixed Assets") is cryptic. Explain what
	the site admin has to create instead.
	"""
	missing = []
	if not frappe.db.exists("Item Group", "Fixed Assets"):
		missing.append(_(
			"an Item Group named <b>Fixed Assets</b> "
			"(<a href='/app/item-group/new'>create Item Group</a>)"
		))
	try:
		has_asset_category = bool(
			frappe.get_all("Asset Category", fields=["name"], limit=1)
		)
	except Exception:
		# Asset Category doctype absent (Assets module not installed).
		has_asset_category = False
	if not has_asset_category:
		missing.append(_(
			"at least one <b>Asset Category</b> "
			"(<a href='/app/asset-category/new'>create Asset Category</a>)"
		))
	if missing:
		frappe.throw(
			_("The <b>Fixed Asset</b> creation type is not set up on this site.")
			+ "<br><br>"
			+ _("Please create the following first, then try again:")
			+ "<ul><li>" + "</li><li>".join(missing) + "</li></ul>",
			title=_("Fixed Asset Setup Required"),
		)


class TSItemCreator(Document):
	def before_validate(self):
		self._fetch_codes()

	def before_save(self):
		# BUG FIX: the desk form / page pre-fills serial_number from the
		# read-only preview endpoint, so a `if not self.serial_number` guard meant
		# _assign_serial() never ran on insert — the TS Code Counter row never
		# advanced and the collision-skip loop never executed, so two concurrent
		# saves minted the SAME item code. A client-supplied serial_number is a
		# preview only and is never authoritative: always re-mint on insert.
		# (The `or not self.serial_number` arm also recovers an existing record
		# that somehow lost its serial.)
		if self.is_new():
			# Discard both client-supplied values before re-minting, so a stale
			# preview can never survive as the stored code (_build_item_code
			# early-returns when its inputs are falsy, which would otherwise
			# leave generated_item_code holding the client's value).
			self.serial_number = None
			self.generated_item_code = None
		if self.is_new() or not self.serial_number:
			self._assign_serial()
		self._build_item_code()
		self._block_item_field_tampering()

	def on_trash(self):
		"""Audit-trail guard — a request that actually minted an Item may not be
		deleted, otherwise the link back from the Item to its approval record is
		silently destroyed."""
		if self.item_created:
			frappe.throw(_(
				"Cannot delete this request: Item <b>{0}</b> was created from it. "
				"The audit trail must be preserved."
			).format(escape_html(str(self.item_created))))

	def _block_item_field_tampering(self):
		"""Tamper guard — only approvers may set the approval
		control-plane fields. A requester must not be able to self-set
		approved_by / status=Created / item_created to fake an approval.
		Our own endpoints set frappe.flags.in_item_request to bypass.
		"""
		if frappe.session.user == "Administrator":
			return
		if getattr(frappe.flags, "in_item_request", False):
			return
		watched = [
			"requested_by", "approved_by", "approved_on",
			"rejection_reason", "status", "item_created",
		]
		if not self.is_new():
			changed = any(self.has_value_changed(f) for f in watched)
		else:
			# On a fresh insert allow the benign request states (Draft /
			# Pending Approval); block anything that asserts an approval.
			changed = bool(
				self.approved_by or self.rejection_reason or self.item_created
				or (self.status not in (None, "", "Draft", "Pending Approval"))
			)
		if not changed:
			return
		if not _is_item_approver():
			raise frappe.PermissionError(_(
				"Approval fields are locked. Only these roles may set them: {0}."
			).format(_approver_roles_label()))

	def _fetch_codes(self):
		"""Fetch company and category codes based on selected code type.
		Skips fetch if codes are already set (e.g. passed from the custom page).
		"""
		if self.company and not self.company_code:
			if self.company_code_type == "Numerical":
				self.company_code = frappe.db.get_value(
					"Company", self.company, "company_num_code"
				) or ""
			else:
				self.company_code = frappe.db.get_value(
					"Company", self.company, "company_code"
				) or ""

		# Fixed Asset path: use Fiscal Year short form as the category key
		if self.creation_type == "Fixed Asset":
			# Derive FY short form (e.g. "2025-2026" -> "25-26")
			if self.fiscal_year:
				self.fiscal_year_short = derive_fy_short(self.fiscal_year)
			else:
				self.fiscal_year_short = ""
			# Override item_group + category_code for asset path.
			# category_code stores the FY short form so downstream serial and
			# code-generation logic can stay generic.
			_ensure_fixed_asset_masters()
			self.item_group = "Fixed Assets"
			self.category_code = self.fiscal_year_short or ""
			# asset_category_code is no longer used in the code, clear it
			self.asset_category_code = ""
			return

		if self.item_group and not self.category_code:
			if self.category_code_type == "Numerical":
				self.category_code = frappe.db.get_value(
					"Item Group", self.item_group, "category_num_code"
				) or ""
			else:
				self.category_code = frappe.db.get_value(
					"Item Group", self.item_group, "category_code"
				) or ""

		# Fetch variant codes for single-variant fields (backward compat)
		if self.has_variant and not self.variants:
			if self.variant_source == "Brand" and self.brand and not self.brand_code:
				self.brand_code = frappe.db.get_value(
					"Brand", self.brand, "brand_code"
				) or ""
			elif self.variant_source == "Custom Variant" and self.variant and not self.variant_code:
				self.variant_code = frappe.db.get_value(
					"TS Variant", self.variant, "variant_code"
				) or ""

	def _assign_serial(self):
		"""Get next serial number for this company + category combination.
		Uses DB-level locking (for_update) to prevent duplicates in bulk imports."""
		if not self.company_code or not self.category_code:
			return

		# Read settings fresh (clear cache to avoid stale data in bulk imports)
		frappe.clear_document_cache("TS Item Code Settings", "TS Item Code Settings")

		# Fixed Asset format always uses 5 serial digits (FA-<company>-25-26-00001)
		is_asset = self.creation_type == "Fixed Asset"
		serial_digits = frappe.db.get_single_value("TS Item Code Settings", "serial_digits")
		digits = 5 if is_asset else max(int(serial_digits or 3), 2)
		sep = frappe.db.get_single_value("TS Item Code Settings", "default_separator") or "-"

		# Use character codes as the counter key (consistent regardless of display type)
		company_key = frappe.db.get_value("Company", self.company, "company_code") or self.company_code

		# Counter key: Fixed Asset uses "FY_25-26"; Regular uses Item Group code
		if is_asset:
			category_key = "FY_" + (self.fiscal_year_short or self.category_code or "")
		else:
			category_key = frappe.db.get_value("Item Group", self.item_group, "category_code") or self.category_code

		# Get current counter directly from DB (bypass cache completely)
		current_serial = frappe.db.sql("""
			SELECT last_serial FROM `tabTS Code Counter`
			WHERE parent = 'TS Item Code Settings' AND company_code = %s AND category_code = %s
			FOR UPDATE
		""", (company_key, category_key))

		if current_serial:
			next_serial = (current_serial[0][0] or 0) + 1
		else:
			# BUG FIX (lost counter updates): the old code loaded the whole
			# TS Item Code Settings Single and called settings.save(), which
			# rewrites the ENTIRE counters child table from a stale in-memory
			# snapshot and can silently revert another transaction's raw UPDATE.
			# Insert the single missing row directly instead, then re-read it
			# under FOR UPDATE so a concurrent inserter serialises behind us.
			_insert_code_counter_row(company_key, category_key)
			locked = frappe.db.sql("""
				SELECT last_serial FROM `tabTS Code Counter`
				WHERE parent = 'TS Item Code Settings' AND company_code = %s AND category_code = %s
				FOR UPDATE
			""", (company_key, category_key))
			next_serial = ((locked[0][0] if locked else 0) or 0) + 1

		# Skip past any existing items (handles previously created items from failed batches)
		while True:
			serial_str = str(next_serial).zfill(digits)
			if is_asset:
				candidate_code = sep.join(["FA", company_key, self.fiscal_year_short or "", serial_str])
			else:
				candidate_code = sep.join([self.company_code, self.category_code, serial_str])
			if not frappe.db.exists("Item", candidate_code):
				break
			next_serial += 1

		# Update counter directly in DB (atomic, no cache issues)
		frappe.db.sql("""
			UPDATE `tabTS Code Counter` SET last_serial = %s
			WHERE parent = 'TS Item Code Settings' AND company_code = %s AND category_code = %s
		""", (next_serial, company_key, category_key))
		# The Single was mutated behind the ORM's back — drop its cached copy.
		frappe.clear_document_cache("TS Item Code Settings", "TS Item Code Settings")

		self.serial_number = str(next_serial).zfill(digits)

	def _build_item_code(self):
		"""Build the generated item code from all parts (base code without variant)."""
		if not self.company_code or not self.category_code or not self.serial_number:
			return

		settings = frappe.get_single("TS Item Code Settings")
		sep = settings.default_separator or "-"

		# Fixed Asset format: FA-{company_code}-{fiscal_year_short}-{serial}
		if self.creation_type == "Fixed Asset":
			company_key = frappe.db.get_value("Company", self.company, "company_code") or self.company_code
			parts = ["FA", company_key, self.fiscal_year_short or "", self.serial_number]
			self.generated_item_code = sep.join(parts)
			return

		# For multi-variant, generated_item_code is the TEMPLATE code (no variant suffix)
		# For standalone, it's the full code
		# For single-variant (backward compat), it includes variant
		parts = [self.company_code, self.category_code, self.serial_number]

		if self.has_variant and not self.variants:
			# Single-variant backward compat
			v_code = ""
			if self.variant_source == "Brand" and self.brand_code:
				v_code = self.brand_code
			elif self.variant_source == "Custom Variant" and self.variant_code:
				v_code = self.variant_code
			if v_code:
				parts.append(v_code)

		self.generated_item_code = sep.join(parts)

	def _validate_hsn_code(self):
		"""Fail early and clearly when the site requires an HSN/SAC code.

		Only enforced where it genuinely applies (see _hsn_validation_active),
		so this app still works on sites without india_compliance.
		"""
		if not _hsn_validation_active():
			return

		if not self.gst_hsn_code:
			frappe.throw(
				_(
					"HSN/SAC Code is required on this site.<br><br>"
					"India Compliance is installed and <b>GST Settings → Validate HSN/SAC Code</b> "
					"is enabled, so ERPNext will refuse to create an Item without one.<br>"
					"Enter the HSN/SAC code for this item and try again."
				),
				frappe.MandatoryError,
				title=_("HSN/SAC Code Required"),
			)

		# Item.gst_hsn_code is a Link to "GST HSN Code" — a value that is not in
		# that master fails link validation much later, with a vaguer message.
		if not frappe.db.exists("GST HSN Code", self.gst_hsn_code):
			frappe.throw(
				_(
					"HSN/SAC Code <b>{0}</b> does not exist in the GST HSN Code master.<br><br>"
					"Pick an existing code from "
					"<a href='/app/gst-hsn-code'>GST HSN Code</a> — the code is stored as a link, "
					"not free text, so it must already be on the list."
				).format(escape_html(self.gst_hsn_code)),
				title=_("Unknown HSN/SAC Code"),
			)

	def validate(self):
		self._validate_hsn_code()

		if not self.company_code:
			frappe.throw(
				f"Company Code not found for <b>{self.company}</b>.<br>"
				f"Go to <a href='/app/company/{self.company}'>Company → {self.company}</a> "
				f"and set the <b>{'company_num_code' if self.company_code_type == 'Numerical' else 'company_code'}</b> field."
			)

		# Fixed Asset path: validate fiscal year + asset category
		if self.creation_type == "Fixed Asset":
			if not self.fiscal_year:
				frappe.throw("Please select a Fiscal Year for Fixed Asset items.")
			if not self.fiscal_year_short:
				frappe.throw(
					f"Could not derive short form from Fiscal Year <b>{self.fiscal_year}</b>.<br>"
					f"Expected format like <b>2025-2026</b>."
				)
			if not self.asset_category:
				frappe.throw(
					"Please select an Asset Category. This is required by ERPNext to "
					"auto-create the Asset record when the Purchase Order is received."
				)
			# Skip variant validation for assets — they don't have variants
			return

		if not self.category_code:
			frappe.throw(
				f"Category Code not found for <b>{self.item_group}</b>.<br>"
				f"Go to <a href='/app/item-group/{self.item_group}'>Item Group → {self.item_group}</a> "
				f"and set the <b>{'category_num_code' if self.category_code_type == 'Numerical' else 'category_code'}</b> field."
			)

		if self.has_variant and self.variants:
			# Multi-variant validation
			for i, row in enumerate(self.variants):
				v_code = row.brand_code or row.variant_code
				if not v_code:
					frappe.throw(
						f"Row {i+1}: Variant code is missing. "
						"Please select a Brand or Custom Variant with a valid code."
					)
		elif self.has_variant:
			# Single-variant backward compat
			if self.variant_source == "Brand" and not self.brand:
				frappe.throw("Please select a Brand or uncheck 'Has Variant'")
			if self.variant_source == "Brand" and self.brand and not self.brand_code:
				frappe.throw(
					f"Brand Code not found for <b>{self.brand}</b>.<br>"
					f"Go to <a href='/app/brand/{self.brand}'>Brand → {self.brand}</a> "
					"and set the <b>brand_code</b> field."
				)
			if self.variant_source == "Custom Variant" and not self.variant:
				frappe.throw("Please select a Custom Variant or uncheck 'Has Variant'")

	@frappe.whitelist(methods=["POST"])
	def create_item(self):
		"""Create Item(s) in ERPNext from the generated item code.

		Privileged: only approvers may mint a real Item (POST-only + an explicit
		role check on top of the ignore_permissions insert).
		Non-approvers must use submit_item_request and await approval.
		"""
		if not _is_item_approver():
			raise frappe.PermissionError(_(
				"Only these roles may create Items: {0}. "
				"Use 'Submit for Approval' instead."
			).format(_approver_roles_label()))

		if self.item_created:
			frappe.throw(
				f"Item(s) already created from this record: <b>{self.item_created}</b>"
			)

		# A rejected request must never mint an Item — the old code only checked
		# item_created, so an approver could re-run create_item on a request that
		# had already been rejected.
		if self.status == "Rejected":
			frappe.throw(_(
				"This request was rejected and cannot create an Item.{0}"
			).format(
				"<br><b>Reason:</b> " + escape_html(self.rejection_reason)
				if self.rejection_reason else ""
			))

		# Never trust a client-submitted generated_item_code. The desk form's
		# _update_preview() rebuilds the code WITHOUT the Fixed-Asset "FA-" prefix
		# and frm.call ships that dirtied value here — which would mint the Item
		# under the wrong code (e.g. ACME-26-27-00017 instead of FA-ACME-26-27-00017).
		# Recompute authoritatively from the persisted serial + master codes before
		# any _create_* branch reads it. Idempotent for every other path.
		self._fetch_codes()
		self._build_item_code()

		if not self.generated_item_code:
			frappe.throw("Generated Item Code is empty. Please save the form first.")

		if self.creation_type == "Fixed Asset":
			result = self._create_fixed_asset_item()
		elif self.has_variant and self.variants:
			result = self._create_multi_variant_items()
		elif self.has_variant:
			result = self._create_variant_item()
		else:
			result = self._create_standalone_item()

		# Update this record
		if result.get("template_code"):
			# Multi-variant: store template in item_created (Link field can only hold one value)
			self.item_created = result["template_code"]
			self.template_item = result["template_code"]
		else:
			self.item_created = result["item_code"]
			self.template_item = ""
		self.status = "Created"
		self.save(ignore_permissions=True)

		frappe.msgprint(
			result["message"],
			title="Item Created",
			indicator="green"
		)

		return result

	@frappe.whitelist(methods=["POST"])
	def approve_request(self):
		"""Approver action — approve a Pending Approval request and create the Item."""
		if not _is_item_approver():
			raise frappe.PermissionError(_("Only approvers may approve item requests."))
		frappe.has_permission("TS Item Creator", "write", doc=self, throw=True)
		if self.status != "Pending Approval":
			frappe.throw(_(
				"Only a request that is 'Pending Approval' can be approved "
				"(current status: {0})."
			).format(self.status or "Draft"))

		frappe.flags.in_item_request = True
		try:
			self.approved_by = frappe.session.user
			self.approved_on = now_datetime()
			self.add_comment("Info", f"[ITEM_APPROVED] by {frappe.session.user}")
		finally:
			frappe.flags.in_item_request = False

		# create_item sets status=Created + item_created and saves (its own approver
		# gate passes for this user); it persists approved_by/approved_on too.
		result = self.create_item()
		_requesters = _item_requester_recipients(self)
		_notify_item_whatsapp(self, "item_approved", _requesters)
		_notify_item_approval_email_bell(self, "item_approved", _requesters)
		return result

	@frappe.whitelist(methods=["POST"])
	def reject_request(self, reason=None):
		"""Approver action — reject a Pending Approval request with a reason."""
		if not _is_item_approver():
			raise frappe.PermissionError(_("Only approvers may reject item requests."))
		frappe.has_permission("TS Item Creator", "write", doc=self, throw=True)
		if self.status != "Pending Approval":
			frappe.throw(_(
				"Only a request that is 'Pending Approval' can be rejected "
				"(current status: {0})."
			).format(self.status or "Draft"))
		reason = (reason or "").strip()
		if not reason:
			frappe.throw(_("A rejection reason is required."))

		frappe.flags.in_item_request = True
		try:
			self.status = "Rejected"
			self.rejection_reason = reason
			self.approved_by = frappe.session.user
			self.approved_on = now_datetime()
			self.add_comment(
				"Info",
				f"[ITEM_REJECTED] by {frappe.session.user}: {escape_html(reason)[:500]}"
			)
			self.save(ignore_permissions=True)
		finally:
			frappe.flags.in_item_request = False

		_requesters = _item_requester_recipients(self)
		_notify_item_whatsapp(self, "item_rejected", _requesters)
		_notify_item_approval_email_bell(self, "item_rejected", _requesters)
		return {"status": self.status, "rejection_reason": self.rejection_reason}

	def _has_custom_posting_date(self):
		"""Check if a custom (backdated) posting date is set."""
		if self.posting_date and getdate(self.posting_date) != getdate():
			return True
		return False

	def _get_common_item_fields(self, item_code, item_name=None):
		"""Return dict of common Item fields used across standalone and variant creation."""
		data = {
			"doctype": "Item",
			"item_code": item_code,
			"item_name": item_name or self.item_name or item_code,
			"item_group": self.item_group,
			"stock_uom": self.stock_uom,
			"description": self.description or self.item_name or item_code,
			"is_stock_item": self.maintain_stock,
		}
		if self.gst_hsn_code:
			data["gst_hsn_code"] = self.gst_hsn_code
		if self.valuation_rate:
			data["valuation_rate"] = self.valuation_rate
		if self.standard_rate:
			data["standard_rate"] = self.standard_rate

		# NEVER pass opening_stock to the Item: core set_opening_stock() ignores
		# the selected warehouse/company (Item has no opening_warehouse field) and
		# books the Stock Entry under the GLOBAL default company. Opening stock is
		# always posted after insert via _create_backdated_opening_stock().

		if self.item_tax_template:
			data["taxes"] = [{"item_tax_template": self.item_tax_template}]
		return data

	def _create_backdated_opening_stock(self, item_code, qty, rate, warehouse=None, company=None):
		"""Create the opening-stock Stock Entry (Material Receipt) honoring the
		selected warehouse + company. posting_date defaults to today when blank —
		this is the ONLY opening-stock path (core set_opening_stock never runs)."""
		from erpnext.stock.doctype.stock_entry.stock_entry_utils import make_stock_entry

		if not qty or flt(qty) <= 0:
			return

		if not rate:
			frappe.throw(f"Valuation Rate is required for backdated opening stock of {item_code}")

		if not company:
			company = frappe.defaults.get_defaults().company

		if not warehouse:
			warehouse = frappe.db.get_value(
				"Warehouse", {"warehouse_name": "Stores", "company": company}
			) or frappe.db.get_single_value("Stock Settings", "default_warehouse")

		if not warehouse:
			frappe.throw(f"Opening Warehouse is required for backdated opening stock of {item_code}")

		posting_date = getdate(self.posting_date) if self.posting_date else getdate()

		stock_entry = make_stock_entry(
			item_code=item_code,
			target=warehouse,
			qty=flt(qty),
			rate=flt(rate),
			company=company,
			posting_date=posting_date,
			posting_time=nowtime(),
			do_not_save=True,
		)

		stock_entry.insert(ignore_permissions=True)
		stock_entry.submit()
		stock_entry.load_from_db()
		stock_entry.add_comment("Comment", f"Opening Stock (Post-dated: {posting_date})")

	def _create_fixed_asset_item(self):
		"""Create a Fixed Asset Item (is_fixed_asset=1, no stock)."""
		item_data = {
			"doctype": "Item",
			"item_code": self.generated_item_code,
			"item_name": self.item_name or self.generated_item_code,
			"item_group": "Fixed Assets",
			"stock_uom": self.stock_uom or "Nos",
			"description": self.description or self.item_name or self.generated_item_code,
			"is_stock_item": 0,
			"is_fixed_asset": 1,
			"asset_category": self.asset_category,
			"asset_naming_series": "ACC-ASS-.YYYY.-",
			"auto_create_assets": 1,
			"is_grouped_asset": 0,
		}
		if self.gst_hsn_code:
			item_data["gst_hsn_code"] = self.gst_hsn_code
		if self.item_tax_template:
			item_data["taxes"] = [{"item_tax_template": self.item_tax_template}]

		item = frappe.get_doc(item_data)
		item.insert(ignore_permissions=True)

		return {
			"item_code": item.name,
			"message": (
				f"Fixed Asset Item <b>{item.name}</b> created successfully.<br>"
				f"Asset Category: <b>{self.asset_category}</b><br>"
				f"You can now create a Purchase Order with this item."
			),
		}

	def _create_standalone_item(self):
		"""Create a standalone item (no variant)."""
		item_data = self._get_common_item_fields(self.generated_item_code)

		item = frappe.get_doc(item_data)
		item.insert(ignore_permissions=True)

		# Post opening stock (all posting dates) honoring warehouse + company
		msg_extra = ""
		if self.maintain_stock and flt(self.opening_stock) > 0:
			self._create_backdated_opening_stock(
				item_code=item.name,
				qty=self.opening_stock,
				rate=self.valuation_rate or self.standard_rate,
				warehouse=self.opening_warehouse,
				company=self.company,
			)
			msg_extra = f"<br>Opening Stock: {self.opening_stock} posted on <b>{self.posting_date or getdate()}</b>"

		return {
			"item_code": item.name,
			"message": f"Item <b>{item.name}</b> created successfully.{msg_extra}"
		}

	def _create_variant_item(self):
		"""Create a template item (if needed) + variant item using ERPNext's variant system."""
		settings = frappe.get_single("TS Item Code Settings")
		sep = settings.default_separator or "-"

		# Template code = company-category-serial (without variant part)
		template_code = sep.join([self.company_code, self.category_code, self.serial_number])

		# Get variant code
		if self.variant_source == "Brand" and self.brand_code:
			variant_code_value = self.brand_code
		elif self.variant_source == "Custom Variant" and self.variant_code:
			variant_code_value = self.variant_code
		else:
			frappe.throw("Variant code is missing. Please select a Brand or Custom Variant.")
			return

		# Ensure the Item Attribute "TS Variant Code" exists
		attr_name = _ensure_variant_attribute(variant_code_value)

		# Step 1: Create or reuse template item
		if not frappe.db.exists("Item", template_code):
			template_data = self._get_common_item_fields(template_code)
			template_data.update({
				"has_variants": 1,
				"variant_based_on": "Item Attribute",
				"attributes": [{"attribute": attr_name}],
			})

			template = frappe.get_doc(template_data)
			template.insert(ignore_permissions=True)
			template_msg = f"Template <b>{template_code}</b> created. "
		else:
			# Template exists - ensure it has has_variants=1 and our attribute
			template = frappe.get_doc("Item", template_code)
			if not template.has_variants:
				frappe.throw(
					f"Item <b>{template_code}</b> already exists but is not a template item. "
					"Cannot create variant under it."
				)

			# Add our attribute if not already present — and re-enable it if a
			# previous edit disabled the row. Frappe v16's Item.validate_variant()
			# throws "Attribute <x> is disabled." for a disabled row on the
			# template, and a name-only check would skip the append and leave no
			# way to recover (v15 had no such check). This attribute is owned by
			# this app, so healing it is safe.
			if not _ensure_template_attribute(template, attr_name):
				template.save(ignore_permissions=True)

			template_msg = f"Using existing template <b>{template_code}</b>. "

		# Step 2: Create variant item
		variant_name = (self.item_name or template_code) + sep + variant_code_value
		variant_data = self._get_common_item_fields(self.generated_item_code, variant_name)
		variant_data.update({
			"variant_of": template_code,
			"variant_based_on": "Item Attribute",
			"attributes": [{
				"attribute": attr_name,
				"attribute_value": variant_code_value,
			}],
		})

		variant_item = frappe.get_doc(variant_data)

		# Set brand if variant source is Brand
		if self.variant_source == "Brand" and self.brand:
			variant_item.brand = self.brand

		variant_item.insert(ignore_permissions=True)

		# Post opening stock for variant (all posting dates)
		msg_extra = ""
		if self.maintain_stock and flt(self.opening_stock) > 0:
			self._create_backdated_opening_stock(
				item_code=variant_item.name,
				qty=self.opening_stock,
				rate=self.valuation_rate or self.standard_rate,
				warehouse=self.opening_warehouse,
				company=self.company,
			)
			msg_extra = f"<br>Opening Stock: {self.opening_stock} posted on <b>{self.posting_date or getdate()}</b>"

		return {
			"item_code": variant_item.name,
			"template_code": template_code,
			"message": template_msg + f"Variant <b>{self.generated_item_code}</b> created successfully.{msg_extra}"
		}

	def _create_multi_variant_items(self):
		"""Create a template item + multiple variant items from the variants child table."""
		settings = frappe.get_single("TS Item Code Settings")
		sep = settings.default_separator or "-"

		# Template code = company-category-serial
		template_code = sep.join([self.company_code, self.category_code, self.serial_number])

		# Check if template already exists
		if frappe.db.exists("Item", template_code):
			existing = frappe.get_doc("Item", template_code)
			if not existing.has_variants:
				frappe.throw(
					f"Item <b>{template_code}</b> already exists but is not a template item."
				)

		# Collect all variant codes first, ensure attributes exist
		variant_codes = []
		for row in self.variants:
			v_code = row.brand_code or row.variant_code
			if not v_code:
				frappe.throw(f"Row {row.idx}: Variant code is missing.")
			variant_codes.append(v_code)

		# Ensure all variant attribute values exist
		attr_name = None
		for v_code in variant_codes:
			attr_name = _ensure_variant_attribute(v_code)

		# Step 1: Create template item if it doesn't exist
		template_msg = ""
		if not frappe.db.exists("Item", template_code):
			template_data = {
				"doctype": "Item",
				"item_code": template_code,
				"item_name": self.item_name or template_code,
				"item_group": self.item_group,
				"stock_uom": self.stock_uom,
				"description": self.item_name or template_code,
				"is_stock_item": self.maintain_stock,
				"has_variants": 1,
				"variant_based_on": "Item Attribute",
				"attributes": [{"attribute": attr_name}],
			}
			if self.gst_hsn_code:
				template_data["gst_hsn_code"] = self.gst_hsn_code
			if self.item_tax_template:
				template_data["taxes"] = [{"item_tax_template": self.item_tax_template}]

			template = frappe.get_doc(template_data)
			template.insert(ignore_permissions=True)
			template_msg = f"Template <b>{template_code}</b> created.<br>"
		else:
			template = frappe.get_doc("Item", template_code)
			# Add the attribute if missing, or re-enable it if disabled (see the
			# matching note in _create_variant_item — v16 rejects a variant whose
			# attribute row is disabled on the template).
			if attr_name and not _ensure_template_attribute(template, attr_name):
				template.save(ignore_permissions=True)
			template_msg = f"Using existing template <b>{template_code}</b>.<br>"

		# Step 2: Create variant items
		created_items = []
		for row in self.variants:
			v_code = row.brand_code or row.variant_code
			variant_item_code = sep.join([template_code, v_code])

			# Skip if already exists
			if frappe.db.exists("Item", variant_item_code):
				template_msg += f"Variant <b>{variant_item_code}</b> already exists (skipped).<br>"
				created_items.append(variant_item_code)
				continue

			variant_name = (self.item_name or template_code) + sep + v_code

			variant_data = {
				"doctype": "Item",
				"item_code": variant_item_code,
				"item_name": variant_name,
				"item_group": self.item_group,
				"stock_uom": self.stock_uom,
				"description": row.description or variant_name,
				"is_stock_item": self.maintain_stock,
				"variant_of": template_code,
				"variant_based_on": "Item Attribute",
				"attributes": [{
					"attribute": attr_name,
					"attribute_value": v_code,
				}],
			}

			if self.gst_hsn_code:
				variant_data["gst_hsn_code"] = self.gst_hsn_code
			if row.valuation_rate:
				variant_data["valuation_rate"] = row.valuation_rate
			if row.standard_rate:
				variant_data["standard_rate"] = row.standard_rate

			# opening_stock deliberately NOT passed to the Item (see
			# _get_common_item_fields) — posted manually below per variant
			if self.item_tax_template:
				variant_data["taxes"] = [{"item_tax_template": self.item_tax_template}]

			variant_item = frappe.get_doc(variant_data)

			# Set brand if present
			if row.brand:
				variant_item.brand = row.brand

			variant_item.insert(ignore_permissions=True)

			# Post opening stock per variant (all posting dates)
			if self.maintain_stock and flt(row.opening_stock) > 0:
				self._create_backdated_opening_stock(
					item_code=variant_item.name,
					qty=row.opening_stock,
					rate=row.valuation_rate or row.standard_rate or self.valuation_rate or self.standard_rate,
					warehouse=self.opening_warehouse,
					company=self.company,
				)
				template_msg += f"Variant <b>{variant_item_code}</b> created (stock posted on {self.posting_date or getdate()}).<br>"
			else:
				template_msg += f"Variant <b>{variant_item_code}</b> created.<br>"

			created_items.append(variant_item.name)

		posting_note = ""
		if self._has_custom_posting_date():
			posting_note = f"<br>Opening stock posted on <b>{self.posting_date}</b>"

		return {
			"item_code": ", ".join(created_items),
			"template_code": template_code,
			"variant_items": created_items,
			"message": template_msg + f"<br><b>{len(created_items)}</b> variant(s) created successfully.{posting_note}"
		}


def _ensure_template_attribute(template, attr_name):
	"""Make sure `template` carries an ENABLED row for `attr_name`.

	Returns True when the template already satisfied that (caller need not
	save), False when a row was added or re-enabled (caller must save).

	Frappe v16 added Item.validate_variant(), which rejects a variant whose
	attribute row on the template is missing *or* disabled
	(erpnext/stock/doctype/item/item.py — "Attribute {0} is disabled."). v15 had
	no equivalent check, so a name-only membership test was sufficient there and
	is not any more: a disabled row would look present, the append would be
	skipped, and the variant insert would fail with no way for the app to heal.
	"""
	for row in template.attributes:
		if row.attribute != attr_name:
			continue
		if row.disabled:
			row.disabled = 0
			return False
		return True

	template.append("attributes", {"attribute": attr_name})
	return False


def _ensure_variant_attribute(variant_code_value):
	"""Ensure the 'TS Variant Code' Item Attribute exists with the given value."""
	attr_name = "TS Variant Code"

	if not frappe.db.exists("Item Attribute", attr_name):
		attr = frappe.get_doc({
			"doctype": "Item Attribute",
			"attribute_name": attr_name,
			"item_attribute_values": [{
				"attribute_value": variant_code_value,
				"abbr": variant_code_value,
			}],
		})
		attr.insert(ignore_permissions=True)
	else:
		attr = frappe.get_doc("Item Attribute", attr_name)
		# Add the value if not already present
		value_exists = any(
			row.attribute_value == variant_code_value
			for row in attr.item_attribute_values
		)
		if not value_exists:
			attr.append("item_attribute_values", {
				"attribute_value": variant_code_value,
				"abbr": variant_code_value,
			})
			attr.save(ignore_permissions=True)

	return attr_name


@frappe.whitelist()
def get_next_serial_preview(company, item_group):
	"""Get the next serial number for preview (without incrementing)."""
	_reject_guest()
	# Read digits directly from DB (bypass cache — user may have just changed it)
	digits_val = frappe.db.get_single_value("TS Item Code Settings", "serial_digits")
	digits = max(int(digits_val or 3), 2)

	company_key = frappe.db.get_value("Company", company, "company_code") or ""
	category_key = frappe.db.get_value("Item Group", item_group, "category_code") or ""

	if not company_key or not category_key:
		return str(1).zfill(digits)

	# Read counter directly from DB (bypass cached singleton)
	result = frappe.db.sql("""
		SELECT last_serial FROM `tabTS Code Counter`
		WHERE parent = 'TS Item Code Settings' AND company_code = %s AND category_code = %s
	""", (company_key, category_key))

	if result:
		return str((result[0][0] or 0) + 1).zfill(digits)

	return str(1).zfill(digits)


@frappe.whitelist()
def get_next_asset_serial_preview(company, fiscal_year):
	"""Get the next serial number for Fixed Asset preview (without incrementing).

	Counter key is 'FY_{fy_short}' per company. Resets naturally on each new
	fiscal year. Returns 5-digit zero-padded serial.
	"""
	_reject_guest()
	digits = 5
	company_key = frappe.db.get_value("Company", company, "company_code") or ""
	fy_short = derive_fy_short(fiscal_year)

	if not company_key or not fy_short:
		return str(1).zfill(digits)

	category_key = "FY_" + fy_short

	result = frappe.db.sql("""
		SELECT last_serial FROM `tabTS Code Counter`
		WHERE parent = 'TS Item Code Settings' AND company_code = %s AND category_code = %s
	""", (company_key, category_key))

	if result:
		return str((result[0][0] or 0) + 1).zfill(digits)

	return str(1).zfill(digits)


@frappe.whitelist()
def get_current_fiscal_year():
	"""Return the Fiscal Year name for today's date, plus its short form."""
	_reject_guest()
	today = getdate()
	fy_list = frappe.get_all(
		"Fiscal Year",
		filters={
			"year_start_date": ["<=", today],
			"year_end_date": [">=", today],
		},
		fields=["name", "year_start_date", "year_end_date"],
		limit=1,
	)
	if not fy_list:
		return {"fiscal_year": "", "fiscal_year_short": ""}
	fy = fy_list[0]
	return {
		"fiscal_year": fy.name,
		"fiscal_year_short": derive_fy_short(fy.name),
	}


@frappe.whitelist()
def get_variant_code(name):
	"""Return TS Variant.variant_code for the given name.

	Ordinary desk roles may lack read perm on the TS Variant master. Wrapping the
	lookup in a whitelisted endpoint that fail-closes lets the flat-form page
	fetch the code without the JS triggering a permission modal.
	Returns {"variant_code": str}; empty string when name not found or no code set.
	"""
	_reject_guest()
	if not name:
		return {"variant_code": ""}
	try:
		code = frappe.db.get_value("TS Variant", name, "variant_code") or ""
		return {"variant_code": code}
	except Exception:
		return {"variant_code": ""}


@frappe.whitelist()
def search_existing_items(query, limit=10):
	"""Duplicate-detection typeahead for the Item Name field.

	Two-stage fuzzy match:
	  Stage 1 — token-LIKE: split query on whitespace; AND each token via
	            `item_name LIKE %token%`. Catches wrong-sequence input
	            (e.g. "rice broken" finds "Broken Rice").
	  Stage 2 — Levenshtein fallback: if Stage 1 returns < 5 rows, run
	            `difflib.get_close_matches` over the most recently modified
	            item_names (cutoff 0.6, capped at FUZZY_SCAN_CAP rows) to catch
	            typos (e.g. "brokn rce" finds "Broken Rice"). In-memory.

	Returns top `limit` matches as a list of dicts, sorted by usage_count
	(PO Item rows) DESC so most-used items rank first.

	Fail-closed: any exception returns []. Empty/short query (<3 chars)
	short-circuits to [] to avoid a 3258-row scan per keystroke.
	"""
	try:
		import difflib

		q = (query or "").strip().lower()
		if len(q) < 3:
			return []

		try:
			lim = max(1, min(int(limit or 10), 25))
		except (TypeError, ValueError):
			lim = 10

		# Permission gate (silent fail-closed — page role JSON is the upstream gate)
		if not frappe.has_permission("Item", "read", throw=False):
			return []

		# Stage 1 — token-LIKE
		tokens = [t for t in q.split() if t]
		seen = set()
		tokens = [t for t in tokens if not (t in seen or seen.add(t))]

		stage1 = []
		if tokens:
			like_clauses = " AND ".join(["LOWER(item_name) LIKE %s"] * len(tokens))
			args = ["%" + t + "%" for t in tokens]
			rows = frappe.db.sql(
				"""
				SELECT name AS item_code, item_name, item_group, brand, stock_uom, disabled
				FROM `tabItem`
				WHERE disabled = 0 AND ({where})
				LIMIT %s
				""".format(where=like_clauses),
				args + [lim * 2],
				as_dict=True,
			)
			stage1 = list(rows)

		# Stage 2 — Levenshtein fallback (only if Stage 1 is weak)
		stage2 = []
		if len(stage1) < 5:
			# Capped scan: on a large item master an uncapped SELECT + difflib
			# pass would blow up per keystroke. FUZZY_SCAN_CAP rows is plenty for
			# a typo-suggestion fallback and degrades gracefully beyond it.
			all_names = frappe.db.sql(
				"SELECT name AS item_code, item_name FROM `tabItem` "
				"WHERE disabled = 0 AND item_name IS NOT NULL "
				"ORDER BY modified DESC LIMIT %s",
				(FUZZY_SCAN_CAP,),
				as_dict=True,
			)
			name_to_code = {r.item_name.lower(): r.item_code for r in all_names if r.item_name}
			close = difflib.get_close_matches(q, list(name_to_code.keys()), n=lim, cutoff=0.6)
			fallback_codes = [name_to_code[n] for n in close]
			if fallback_codes:
				placeholders = ",".join(["%s"] * len(fallback_codes))
				stage2 = frappe.db.sql(
					"SELECT name AS item_code, item_name, item_group, brand, stock_uom, disabled "
					"FROM `tabItem` WHERE name IN ({p})".format(p=placeholders),
					fallback_codes,
					as_dict=True,
				)

		# Merge + dedupe by item_code
		merged = {}
		for r in stage1 + stage2:
			if r.item_code not in merged:
				merged[r.item_code] = r
		results = list(merged.values())

		if not results:
			return []

		# usage_count subquery — count Purchase Order Item rows per item_code
		codes = [r.item_code for r in results]
		placeholders = ",".join(["%s"] * len(codes))
		usage_rows = frappe.db.sql(
			"SELECT item_code, COUNT(*) AS cnt FROM `tabPurchase Order Item` "
			"WHERE item_code IN ({p}) GROUP BY item_code".format(p=placeholders),
			codes,
			as_dict=True,
		)
		usage_map = {r.item_code: int(r.cnt) for r in usage_rows}

		for r in results:
			r["usage_count"] = usage_map.get(r.item_code, 0)

		results.sort(key=lambda r: (-r["usage_count"], r["item_name"] or ""))
		return results[:lim]
	except Exception:
		return []


# --------------------------------------------------------------------------- #
# Approval notifications — email + bell (Notification Log). Fail-soft: never
# raises into the item-request flow.
# --------------------------------------------------------------------------- #
def _item_approver_recipients():
	"""Active users who can approve item requests (excludes the blanket System
	Manager role so god-mode accounts are not nudged)."""
	try:
		approver_roles = _get_approver_roles()
		users = set()
		for role in approver_roles - {"System Manager"}:
			users.update(_get_role_users(role) or [])
		# On a site where System Manager is the only approver role, excluding it
		# would leave nobody to notify — fall back to the full set instead.
		if not users:
			for role in approver_roles:
				users.update(_get_role_users(role) or [])
		return list(users)
	except Exception:
		return []


def _item_requester_recipients(doc):
	"""The requester + creator of a request — notified on approve / reject."""
	out = []
	for u in (doc.get("requested_by"), doc.owner):
		if u and u not in out:
			out.append(u)
	return out


def _notify_item_whatsapp(doc, action, recipients):
	"""Extension point for an out-of-band (e.g. WhatsApp/SMS) approval nudge.

	Intentionally a no-op in this standalone app — it has no messaging provider
	of its own and must not depend on any other app. A site that wants such a
	channel can monkey-patch this function or override it from a site app; the
	email + bell channel in _notify_item_approval_email_bell is the supported one
	and always fires.
	"""
	return


def _notify_item_approval_email_bell(doc, action, recipients):
	"""Bell (Notification Log) + email for an Item Creator approval event.

	This is the supported notification channel and the only one this app ships
	with. Fully fail-soft: a notification error can NEVER bubble into the
	submit/approve/reject flow.
	"""
	try:
		recipients = list({r for r in (recipients or []) if r and r != "Administrator"})
		if not recipients:
			return

		code = doc.get("generated_item_code") or doc.name
		item_name = doc.get("item_name") or ""
		requester = doc.get("requested_by") or doc.owner or ""
		subjects = {
			"item_pending": f"[Action Required] Item request {doc.name} ({code}) awaiting your approval",
			"item_approved": f"[Approved] Item request {doc.name} ({code}) — Item created",
			"item_rejected": f"[Rejected] Item request {doc.name} ({code}) — Rejected",
		}
		subject = subjects.get(action, f"Item request {doc.name} — Approval Update")

		if action == "item_pending":
			body = "<p>A new item-creation request needs your approval.</p>"
		elif action == "item_approved":
			body = "<p>Your item-creation request has been approved and the Item was created.</p>"
		elif action == "item_rejected":
			body = (
				"<p>Your item-creation request was rejected.</p>"
				f"<p><b>Reason:</b> {escape_html(doc.get('rejection_reason') or '')}</p>"
			)
		else:
			body = "<p>Item request status updated.</p>"

		message = body + (
			"<ul>"
			f"<li><b>Request:</b> {escape_html(doc.name)}</li>"
			f"<li><b>Item Code:</b> {escape_html(code)}</li>"
			f"<li><b>Item Name:</b> {escape_html(item_name)}</li>"
			f"<li><b>Requested By:</b> {escape_html(requester)}</li>"
			f"<li><b>Status:</b> {escape_html(doc.get('status') or '')}</li>"
			"</ul>"
		)

		for user in recipients:
			try:
				note = frappe.new_doc("Notification Log")
				note.for_user = user
				note.from_user = frappe.session.user
				note.document_type = doc.doctype
				note.document_name = doc.name
				note.subject = subject
				note.type = "Alert"
				note.insert(ignore_permissions=True)
			except Exception:
				frappe.log_error(
					title=f"Item notif bell error ({doc.name})"[:140],
					message=frappe.get_traceback(),
				)

		try:
			frappe.sendmail(
				recipients=recipients,
				subject=subject,
				message=message,
				reference_doctype=doc.doctype,
				reference_name=doc.name,
			)
		except Exception:
			frappe.log_error(
				title=f"Item notif email error ({doc.name})"[:140],
				message=frappe.get_traceback(),
			)
	except Exception:
		# Never let a notification failure break the approval flow.
		pass


@frappe.whitelist(methods=["POST"])
def submit_item_request(doc):
	"""Non-approver entry point — insert an item-creation request in 'Pending
	Approval' WITHOUT creating any Item. Gated by the desk-staff denylist.

	Uses ignore_permissions (AFTER the denylist gate) so the raw TS Item Creator
	doctype need not be opened to every desk role — the denylist IS the explicit
	permission check, and there are no permlevel>0 fields here.
	"""
	if not _can_request_item():
		raise frappe.PermissionError(_(
			"You are not permitted to submit item-creation requests."
		))

	if isinstance(doc, str):
		doc = json.loads(doc)
	doc = dict(doc or {})
	# Force doctype + strip any control-plane / server-computed fields a caller
	# might inject; the server recomputes serial/code and sets status itself.
	doc["doctype"] = "TS Item Creator"
	for f in (
		"name", "status", "item_created", "template_item", "approved_by",
		"approved_on", "rejection_reason", "requested_by",
		"serial_number", "generated_item_code",
		# Ownership + ledger-affecting fields: a requester must not be able to
		# impersonate another owner, nor stage a BACKDATED opening-stock Stock
		# Entry that the approver then submits unseen. posting_date always falls
		# back to today (see _create_backdated_opening_stock); an approver who
		# genuinely needs a backdate sets it on the saved request themselves.
		"owner", "posting_date",
		"docstatus", "creation", "modified", "modified_by", "idx",
	):
		doc.pop(f, None)

	frappe.flags.in_item_request = True
	try:
		d = frappe.get_doc(doc)
		d.requested_by = frappe.session.user
		d.status = "Pending Approval"
		d.insert(ignore_permissions=True)
		d.add_comment("Info", f"[ITEM_REQUEST] submitted by {frappe.session.user}")
	finally:
		frappe.flags.in_item_request = False

	_approvers = _item_approver_recipients()
	_notify_item_whatsapp(d, "item_pending", _approvers)
	_notify_item_approval_email_bell(d, "item_pending", _approvers)
	return {
		"name": d.name,
		"status": d.status,
		"generated_item_code": d.generated_item_code,
	}


@frappe.whitelist()
def is_current_user_item_approver():
	"""Lets the Item Creator page choose the submit-vs-create
	branch without the JS reading roles directly (avoids a perm modal)."""
	_reject_guest()
	return {"is_approver": _is_item_approver()}


@frappe.whitelist()
def get_my_recent_requests(limit=6):
	"""The Item Creator page 'Recent' list for ANY desk user,
	without requiring read DocPerm on TS Item Creator (the page is now open to
	non-approver desk staff who lack that perm). Returns the caller's OWN recent
	records only. Fail-closed: any error / Guest returns []."""
	user = frappe.session.user
	if user in ("Guest", "", None):
		return []
	try:
		lim = max(1, min(int(limit or 6), 20))
	except (TypeError, ValueError):
		lim = 6
	try:
		return frappe.get_all(
			"TS Item Creator",
			filters={"owner": user},
			fields=["name", "generated_item_code", "item_name", "status", "item_created"],
			order_by="creation desc",
			# `limit`, not `limit_page_length`: Frappe v16 routes get_all through
			# frappe.model.qb_query, which deprecates the latter (slated for removal
			# in v17) and warns on every call. v15's db_query accepts `limit` too,
			# so this works on both.
			limit=lim,
		)
	except Exception:
		return []
