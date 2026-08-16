app_name = "item_creator"
app_title = "Item Creator"
app_publisher = "Trustbit Software"
app_description = "Guided item creation with server-generated item codes for ERPNext"
app_email = "info@trustbit.com"
app_license = "mit"

# The app creates Items, Item Attributes and Stock Entries and reads Company /
# Item Group / Brand, so ERPNext is a hard dependency. Declaring it here makes
# `install-app` refuse up front on a frappe-only site instead of failing later
# with an unrelated-looking error.
required_apps = ["erpnext"]

# ── Assets ──────────────────────────────────────────────────────────────────
# Loaded on every desk page. item_list.js repoints the Item list's primary
# action at the Item Creator page — that redirect is how the guided flow is
# actually enforced, so it must be a global include rather than a list-view
# script (list settings are per-site and can be overwritten).
app_include_js = "/assets/item_creator/js/item_list.js"

# ── Install / migrate ───────────────────────────────────────────────────────
# Both entry points call the same idempotent routine, so a site that installed
# an older version picks up newly added fields on the next `bench migrate`.
after_install = "item_creator.install.after_install"
after_migrate = "item_creator.install.after_migrate"
