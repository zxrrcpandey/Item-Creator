// Override Item list "+ Add Item" button to redirect to custom Item Creator wizard
$(document).on("page-change", function () {
	const route = frappe.get_route();
	if (route[0] === "List" && route[1] === "Item") {
		// Wait for list to render
		setTimeout(() => {
			const page = cur_list && cur_list.page;
			if (!page) return;

			// Replace primary action
			page.set_primary_action(__("Create New Item"), () => {
				frappe.set_route("item-creator");
			}, "add");
		}, 500);
	}
});
