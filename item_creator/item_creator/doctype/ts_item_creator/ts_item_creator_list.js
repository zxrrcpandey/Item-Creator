frappe.listview_settings["TS Item Creator"] = {
	refresh(listview) {
		// Override the primary action button to open the Item Creator wizard page
		listview.page.set_primary_action(__("Item Creator"), function () {
			frappe.set_route("item-creator");
		}, "add");
	},
};
