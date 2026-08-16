// Route the Item list's primary "create" button into the Item Creator page.
//
// This is implemented as a ListView.prototype override rather than the more
// obvious frappe.listview_settings["Item"].primary_action, because two things
// fight a simpler approach:
//   1. ListView re-applies its own primary action after render and whenever the
//      bulk-actions menu is toggled, so a one-shot setTimeout hijack is undone.
//   2. ERPNext assigns frappe.listview_settings["Item"] wholesale, so any
//      property we set there survives only if our script happens to load last.
// Overriding the method itself is immune to both: every call routes through us.
frappe.provide("frappe.views");

(function () {
	const TARGET_DOCTYPE = "Item";
	const TARGET_ROUTE = "item-creator";
	let patched = false;

	function patch() {
		if (patched) return true;

		const ListView = frappe.views && frappe.views.ListView;
		if (!ListView || !ListView.prototype || !ListView.prototype.set_primary_action) {
			return false;
		}

		const original = ListView.prototype.set_primary_action;

		ListView.prototype.set_primary_action = function () {
			const is_target = this.doctype === TARGET_DOCTYPE;
			const may_create = this.can_create && !(frappe.boot && frappe.boot.read_only);

			if (is_target && may_create) {
				this.page.set_primary_action(
					__("Create New Item"),
					() => frappe.set_route(TARGET_ROUTE),
					"add"
				);
				return;
			}

			return original.apply(this, arguments);
		};

		patched = true;
		return true;
	}

	// frappe.views.ListView may not exist yet when a global desk include runs,
	// so fall back to retrying on the events that fire once the desk is ready.
	if (!patch()) {
		$(document).on("startup", patch);
		$(document).on("page-change", patch);
	}
})();
