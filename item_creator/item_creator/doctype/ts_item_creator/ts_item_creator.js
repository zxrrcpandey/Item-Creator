frappe.ui.form.on("TS Item Creator", {
	setup(frm) {
		// Filter TS Variant to only enabled ones
		frm.set_query("variant", function () {
			return { filters: { enabled: 1 } };
		});
	},

	refresh(frm) {
		// Which roles may approve is site-configurable (TS Item Code Settings →
		// approver_roles), so the answer has to come from the server, not from a
		// role list baked into this file. Resolve it once per page load; the
		// helper seeds a stock-role fallback synchronously so this first render
		// is never blank, and re-renders only if the server disagrees.
		if (_approver_state === null) {
			_resolve_approver(frm);
		}

		// Lock all fields once the request is no longer an editable Draft —
		// EXCEPT for approvers, who may edit a request at ANY status. This is a
		// UX gate only: the server still enforces who may approve/create and the
		// before_save tamper guard (_block_item_field_tampering) re-checks the
		// approver roles, so unlocking the form here cannot bypass any
		// server-side control.
		if (
			["Created", "Rejected", "Pending Approval"].includes(frm.doc.status) &&
			!_is_item_approver()
		) {
			_lock_all_fields(frm);
		}

		// Create Item button — approver self-create on a Draft (one-step)
		if (
			frm.doc.status === "Draft" &&
			!frm.is_new() &&
			frm.doc.generated_item_code &&
			_is_item_approver()
		) {
			frm.add_custom_button(__("Create Item"), function () {
				frappe.confirm(
					`Create Item with code <b>${frm.doc.generated_item_code}</b>?`,
					function () {
						frm.call("create_item").then(() => {
							frm.reload_doc();
						});
					}
				);
			}, null).addClass("btn-primary");
		}

		// Approve / Reject — approver acting on a pending request
		if (frm.doc.status === "Pending Approval" && !frm.is_new() && _is_item_approver()) {
			frm.add_custom_button(__("Approve"), function () {
				frappe.confirm(
					`Approve and create Item <b>${frappe.utils.escape_html(frm.doc.generated_item_code || "")}</b>?`,
					function () {
						frm.call("approve_request").then(() => frm.reload_doc());
					}
				);
			}, null).addClass("btn-primary");

			frm.add_custom_button(__("Reject"), function () {
				frappe.prompt(
					[{ fieldname: "reason", fieldtype: "Small Text", label: __("Rejection Reason"), reqd: 1 }],
					function (values) {
						// String form sets doc=this.doc → routes to the reject_request
						// DOC method. The object form (without doc) wrongly routes to a
						// non-existent MODULE-level reject_request and silently fails —
						// that was the "can't reject" bug (zero Rejected records ever).
						frm.call("reject_request", { reason: values.reason })
							.then(() => frm.reload_doc());
					},
					__("Reject Item Request"),
					__("Reject")
				);
			});
		}

		// View Item button
		if (frm.doc.item_created) {
			frm.add_custom_button(__(frm.doc.template_item ? "View Variant Item" : "View Item"), function () {
				frappe.set_route("Form", "Item", frm.doc.item_created);
			});
		}

		// View Template Item button
		if (frm.doc.template_item) {
			frm.add_custom_button(__("View Template Item"), function () {
				frappe.set_route("Form", "Item", frm.doc.template_item);
			});
		}

		// Status indicator
		const _ind = { Created: "green", Rejected: "red", "Pending Approval": "orange", Draft: "gray" };
		frm.page.set_indicator(__(frm.doc.status || "Draft"), _ind[frm.doc.status] || "gray");

		// Update preview on refresh — ONLY while still an editable Draft. On a
		// finalized request (Pending Approval / Created / Rejected) the stored
		// generated_item_code is authoritative; recomputing it here would dirty
		// the form and (for Fixed Assets) ship a wrong code to approve_request.
		if (!frm.is_new() && frm.doc.status === "Draft") {
			_update_preview(frm);
		}
	},

	// ── Company change ──
	company(frm) {
		if (frm.doc.company) {
			_fetch_company_code(frm);
		} else {
			frm.set_value("company_code", "");
			_update_preview(frm);
		}
	},

	company_code_type(frm) {
		if (frm.doc.company) {
			_fetch_company_code(frm);
		}
	},

	// ── Category change ──
	item_group(frm) {
		if (frm.doc.item_group) {
			_fetch_category_code(frm);
		} else {
			frm.set_value("category_code", "");
			_update_preview(frm);
		}
	},

	category_code_type(frm) {
		if (frm.doc.item_group) {
			_fetch_category_code(frm);
		}
	},

	// ── Variant toggle ──
	has_variant(frm) {
		if (!frm.doc.has_variant) {
			frm.set_value("variant_source", "Brand");
			frm.set_value("brand", "");
			frm.set_value("brand_code", "");
			frm.set_value("variant", "");
			frm.set_value("variant_code", "");
		}
		_update_preview(frm);
	},

	variant_source(frm) {
		// Clear the other source's fields
		if (frm.doc.variant_source === "Brand") {
			frm.set_value("variant", "");
			frm.set_value("variant_code", "");
		} else {
			frm.set_value("brand", "");
			frm.set_value("brand_code", "");
		}
		_update_preview(frm);
	},

	brand(frm) {
		if (frm.doc.brand) {
			frappe.db.get_value("Brand", frm.doc.brand, "brand_code", (r) => {
				frm.set_value("brand_code", r ? r.brand_code : "");
				_update_preview(frm);
			});
		} else {
			frm.set_value("brand_code", "");
			_update_preview(frm);
		}
	},

	variant(frm) {
		if (frm.doc.variant) {
			frappe.db.get_value("TS Variant", frm.doc.variant, "variant_code", (r) => {
				frm.set_value("variant_code", r ? r.variant_code : "");
				_update_preview(frm);
			});
		} else {
			frm.set_value("variant_code", "");
			_update_preview(frm);
		}
	},

	item_name(frm) {
		_update_preview(frm);
	},
});

// ── Helper: client-side approver check (UX gate only — server re-checks) ──
// Defaults mirror the server's fallback when TS Item Code Settings →
// approver_roles is left blank. All three are stock ERPNext roles.
const _DEFAULT_APPROVER_ROLES = ["System Manager", "Item Manager", "Stock Manager"];

// null = not yet resolved; true/false once known. Cached for the page load.
let _approver_state = null;

function _fallback_approver() {
	if (frappe.session.user === "Administrator") return true;
	const roles = frappe.user_roles || [];
	return _DEFAULT_APPROVER_ROLES.some((r) => roles.includes(r));
}

function _resolve_approver(frm) {
	// Seed synchronously so _approver_state is never left null — if the call
	// below never comes back we still render with a sane default instead of
	// re-firing it on every refresh.
	_approver_state = _fallback_approver();

	frappe.call({
		method:
			"item_creator.item_creator.doctype.ts_item_creator.ts_item_creator.is_current_user_item_approver",
		callback(r) {
			const resolved = !!(r && r.message);
			if (resolved !== _approver_state) {
				_approver_state = resolved;
				frm.refresh();
			}
		},
	});
}

function _is_item_approver() {
	return _approver_state === null ? _fallback_approver() : _approver_state;
}

// ── Helper: Fetch company code ──
function _fetch_company_code(frm) {
	const field =
		frm.doc.company_code_type === "Numerical"
			? "company_num_code"
			: "company_code";

	frappe.db.get_value("Company", frm.doc.company, field, (r) => {
		frm.set_value("company_code", r ? r[field] || "" : "");
		_fetch_serial_preview(frm);
	});
}

// ── Helper: Fetch category code ──
function _fetch_category_code(frm) {
	const field =
		frm.doc.category_code_type === "Numerical"
			? "category_num_code"
			: "category_code";

	frappe.db.get_value("Item Group", frm.doc.item_group, field, (r) => {
		frm.set_value("category_code", r ? r[field] || "" : "");
		_fetch_serial_preview(frm);
	});
}

// ── Helper: Fetch next serial preview ──
function _fetch_serial_preview(frm) {
	if (frm.doc.company && frm.doc.item_group && !frm.doc.serial_number) {
		frappe.call({
			method:
				"item_creator.item_creator.doctype.ts_item_creator.ts_item_creator.get_next_serial_preview",
			args: {
				company: frm.doc.company,
				item_group: frm.doc.item_group,
			},
			callback(r) {
				if (r.message) {
					// Show preview serial (not committed yet)
					frm.set_value("serial_number", r.message);
					_update_preview(frm);
				}
			},
		});
	} else {
		_update_preview(frm);
	}
}

// ── Helper: Update preview ──
function _update_preview(frm) {
	const ser = frm.doc.serial_number || "";

	// Fixed Asset: FA-{company_code}-{fiscal_year_short}-{serial}
	// Mirror the server _build_item_code() so the preview (and the value shipped
	// by frm.call) keeps the "FA-" prefix. A plain cc-cat-ser build here was the
	// root cause of Fixed Assets being minted without the prefix on approval.
	if (frm.doc.creation_type === "Fixed Asset") {
		const acc = frm.doc.company_code || "";
		const fy = frm.doc.fiscal_year_short || "";
		if (!acc || !fy) {
			frm.set_value("generated_item_code", "");
			return;
		}
		frm.set_value("generated_item_code", ["FA", acc, fy, ser || "_____"].join("-"));
		return;
	}

	const cc = frm.doc.company_code || "";
	const cat = frm.doc.category_code || "";

	if (!cc || !cat) {
		frm.set_value("generated_item_code", "");
		return;
	}

	let parts = [cc, cat, ser || "___"];

	if (frm.doc.has_variant) {
		let v_code = "";
		if (frm.doc.variant_source === "Brand") {
			v_code = frm.doc.brand_code || "";
		} else {
			v_code = frm.doc.variant_code || "";
		}
		if (v_code) {
			parts.push(v_code);
		}
	}

	// Use "-" as default separator (will be overridden by server on save)
	const code = parts.join("-");
	frm.set_value("generated_item_code", code);
}

// ── Helper: Lock all fields after creation ──
function _lock_all_fields(frm) {
	const fields_to_lock = [
		"company",
		"company_code_type",
		"item_group",
		"category_code_type",
		"has_variant",
		"variant_source",
		"brand",
		"variant",
		"item_name",
		"stock_uom",
		"description",
	];
	fields_to_lock.forEach((f) => {
		frm.set_df_property(f, "read_only", 1);
	});
}
