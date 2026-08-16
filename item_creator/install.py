"""Install-time setup for the Item Creator app.

The app builds item codes out of short codes stored on master data (Company,
Item Group, Brand). Those code fields are not part of stock ERPNext, so the app
ships them as Custom Fields and creates them here.

Everything in this module must be safe to run repeatedly: `after_migrate` fires
on every `bench migrate`, and a partially-configured site must be able to heal
itself by re-running it.
"""

from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

# Master-data code fields consumed by the Item Creator page and by
# item_creator.item_creator.doctype.ts_item_creator.ts_item_creator when it
# assembles an item code.
CUSTOM_FIELDS = {
	"Company": [
		{
			"fieldname": "company_code",
			"label": "Company Code (ABC)",
			"fieldtype": "Data",
			"insert_after": "company_name",
			"description": "3-letter character code for item coding (e.g., ACM, TBT)",
		},
		{
			"fieldname": "company_num_code",
			"label": "Company Code (123)",
			"fieldtype": "Data",
			"insert_after": "company_code",
			"description": "2-digit numerical code for item coding (e.g., 01, 02)",
		},
	],
	"Item Group": [
		{
			"fieldname": "category_code",
			"label": "Category Code (ABC)",
			"fieldtype": "Data",
			"insert_after": "item_group_name",
			"description": "3-letter character code for item coding (e.g., GRN, COL)",
		},
		{
			"fieldname": "category_num_code",
			"label": "Category Code (123)",
			"fieldtype": "Data",
			"insert_after": "category_code",
			"description": "2-digit numerical code for item coding (e.g., 01, 02)",
		},
	],
	"Brand": [
		{
			"fieldname": "brand_code",
			"label": "Brand Code",
			"fieldtype": "Data",
			"insert_after": "brand",
			"description": "3-letter code for item coding (e.g., CAR, ADM, MCL)",
		},
	],
}


def install_custom_fields():
	"""Create the master-data code fields, or refresh them if they exist.

	`update=True` makes this idempotent: missing fields are inserted, and
	fields that already exist have their label/description/position brought
	back in line with the definitions above instead of raising a duplicate
	error. Safe on a fresh install and on every migrate.
	"""
	create_custom_fields(CUSTOM_FIELDS, update=True)


def after_install():
	install_custom_fields()


def after_migrate():
	install_custom_fields()
