import frappe
from frappe.model.document import Document


class TSVariant(Document):
	def validate(self):
		if self.variant_code:
			self.variant_code = self.variant_code.upper().strip()
			if len(self.variant_code) > 3:
				frappe.throw("Variant Code must be 3 characters or less")
			if not self.variant_code.isalnum():
				frappe.throw("Variant Code must contain only letters and numbers")
