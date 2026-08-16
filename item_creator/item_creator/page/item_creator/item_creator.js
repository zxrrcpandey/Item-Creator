// Item Creator — flat-form page controller
// Sections: basics → details → variants (collapsible) → stock → opening (collapsible)
// No wizard / no step state machine. Single state object + section open/closed map.

frappe.pages["item-creator"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "Item Creator",
		single_column: true,
	});
	page.set_title_sub("Build structured item codes for ERPNext");
	$(frappe.render_template("item_creator")).appendTo(page.body);
	new TSItemCreator(page);
};

class TSItemCreator {
	constructor(page) {
		this.page = page;
		this.$page = $(page.body);

		this.state = {
			creation_type: "Regular Item",
			asset_category: "",
			fiscal_year: "",
			fiscal_year_short: "",
			company: "",
			company_code_type: "Numerical",
			company_code: "",
			item_group: "",
			category_code_type: "Numerical",
			category_code: "",
			serial_number: "",
			has_variant: false,
			variant_source: "Brand",
			item_name: "",
			stock_uom: "Nos",
			gst_hsn_code: "",
			item_tax_template: "",
			maintain_stock: 1,
			valuation_rate: 0,
			standard_rate: 0,
			opening_stock: 0,
			opening_warehouse: "",
			posting_date: "",
			description: "",
		};

		this.variant_rows = [];
		this._variant_row_counter = 0;
		this._prompt_open = false;
		this._category_code_fetching = false;

		this._is_approver = false;

		this._setup_fields();
		this._bind_events();
		this._refresh_meta_summaries();
		this._load_recent();
		this._fetch_approver_flag();
	}

	// ── Approver flag — decides the submit-vs-create branch (server re-checks) ──
	_fetch_approver_flag() {
		const me = this;
		frappe.call({
			method: "item_creator.item_creator.doctype.ts_item_creator.ts_item_creator.is_current_user_item_approver",
			callback(r) {
				me._is_approver = !!(r.message && r.message.is_approver);
				me._apply_create_label();
			},
		});
	}

	_apply_create_label() {
		const $label = this.$page.find("#itc-btn-create .itc-btn-label");
		if ($label.length) {
			$label.text(this._is_approver ? "Create Item" : "Submit for Approval");
		}
	}

	// ── Helper: debounce Link control changes ──
	_on_link_value(control, callback) {
		let _timer = null;
		let _last_val = null;
		const debounced = (val) => {
			clearTimeout(_timer);
			_timer = setTimeout(() => {
				if (val !== _last_val) {
					_last_val = val;
					callback(val);
				}
			}, 200);
		};
		const orig = control.set_formatted_input.bind(control);
		control.set_formatted_input = function (value) {
			orig(value);
			debounced(control.get_value());
		};
		control.$input.on("change", () => debounced(control.get_value()));
	}

	// ── Setup Frappe field controls ──
	_setup_fields() {
		const me = this;

		this.company_field = frappe.ui.form.make_control({
			df: { fieldtype: "Link", options: "Company", placeholder: "Select Company..." },
			parent: this.$page.find("#itc-company-field"),
			render_input: true,
		});
		this._on_link_value(this.company_field, (val) => {
			me.state.company = val || "";
			me._clear_error("company");
			me._fetch_company_code();
		});

		this.category_field = frappe.ui.form.make_control({
			df: { fieldtype: "Link", options: "Item Group", placeholder: "Select Item Group..." },
			parent: this.$page.find("#itc-category-field"),
			render_input: true,
		});
		this._on_link_value(this.category_field, (val) => {
			me.state.item_group = val || "";
			me._clear_error("category");
			me._fetch_category_code();
		});

		this.asset_category_field = frappe.ui.form.make_control({
			df: { fieldtype: "Link", options: "Asset Category", placeholder: "Select Asset Category..." },
			parent: this.$page.find("#itc-asset-category-field"),
			render_input: true,
		});
		this._on_link_value(this.asset_category_field, (val) => {
			me.state.asset_category = val || "";
			me._clear_error("asset-cat");
			me._refresh_meta_summaries();
			me._update_preview();
		});

		this.fiscal_year_field = frappe.ui.form.make_control({
			df: { fieldtype: "Link", options: "Fiscal Year", placeholder: "Select Fiscal Year..." },
			parent: this.$page.find("#itc-fiscal-year-field"),
			render_input: true,
		});
		this._on_link_value(this.fiscal_year_field, (val) => {
			me.state.fiscal_year = val || "";
			me._clear_error("fy");
			me._derive_fy_short();
		});

		this.item_name_field = frappe.ui.form.make_control({
			df: { fieldtype: "Data", placeholder: "e.g. Hex Bolt M10 x 50mm" },
			parent: this.$page.find("#itc-item-name-field"),
			render_input: true,
		});
		this.item_name_field.$input.on("input change", () => {
			me.state.item_name = me.item_name_field.get_value() || "";
			me._refresh_meta_summaries();
		});
		this._setup_item_name_typeahead();

		this.uom_field = frappe.ui.form.make_control({
			df: { fieldtype: "Link", options: "UOM", placeholder: "Select UOM..." },
			parent: this.$page.find("#itc-uom-field"),
			render_input: true,
		});
		this.uom_field.set_value("Nos");
		this._on_link_value(this.uom_field, (val) => {
			me.state.stock_uom = val || "Nos";
			me._clear_error("uom");
			me._refresh_meta_summaries();
		});

		this.hsn_field = frappe.ui.form.make_control({
			df: { fieldtype: "Link", options: "GST HSN Code", placeholder: "Search HSN/SAC code..." },
			parent: this.$page.find("#itc-hsn-field"),
			render_input: true,
		});
		this._on_link_value(this.hsn_field, (val) => {
			me.state.gst_hsn_code = val || "";
			me._clear_error("hsn");
			me._refresh_meta_summaries();
		});

		this.tax_template_field = frappe.ui.form.make_control({
			df: {
				fieldtype: "Link",
				options: "Item Tax Template",
				placeholder: "Select tax template...",
				get_query: () => ({ filters: { company: me.state.company || undefined } }),
			},
			parent: this.$page.find("#itc-tax-template-field"),
			render_input: true,
		});
		this._on_link_value(this.tax_template_field, (val) => {
			me.state.item_tax_template = val || "";
			me._refresh_meta_summaries();
		});

		this.valuation_rate_field = frappe.ui.form.make_control({
			df: { fieldtype: "Currency", placeholder: "0.00" },
			parent: this.$page.find("#itc-valuation-rate-field"),
			render_input: true,
		});
		this.valuation_rate_field.$input.on("change", () => {
			me.state.valuation_rate = flt(me.valuation_rate_field.get_value());
			me._clear_error("valuation");
			me._refresh_meta_summaries();
		});

		this.standard_rate_field = frappe.ui.form.make_control({
			df: { fieldtype: "Currency", placeholder: "0.00" },
			parent: this.$page.find("#itc-standard-rate-field"),
			render_input: true,
		});
		this.standard_rate_field.$input.on("change", () => {
			me.state.standard_rate = flt(me.standard_rate_field.get_value());
			me._refresh_meta_summaries();
		});

		this.opening_stock_field = frappe.ui.form.make_control({
			df: { fieldtype: "Float", placeholder: "0" },
			parent: this.$page.find("#itc-opening-stock-field"),
			render_input: true,
		});
		this.opening_stock_field.$input.on("change", () => {
			me.state.opening_stock = flt(me.opening_stock_field.get_value());
			me._clear_error("opening-stock");
			me._toggle_posting_date_row();
			me._refresh_meta_summaries();
		});

		this.opening_warehouse_field = frappe.ui.form.make_control({
			df: {
				fieldtype: "Link",
				options: "Warehouse",
				placeholder: "Select warehouse...",
				get_query: () => ({ filters: { company: me.state.company || undefined } }),
			},
			parent: this.$page.find("#itc-opening-warehouse-field"),
			render_input: true,
		});
		this._on_link_value(this.opening_warehouse_field, (val) => {
			me.state.opening_warehouse = val || "";
			me._clear_error("warehouse");
		});

		this.opening_warehouse_variant_field = frappe.ui.form.make_control({
			df: {
				fieldtype: "Link",
				options: "Warehouse",
				placeholder: "Select warehouse...",
				get_query: () => ({ filters: { company: me.state.company || undefined } }),
			},
			parent: this.$page.find("#itc-opening-warehouse-variant-field"),
			render_input: true,
		});
		this._on_link_value(this.opening_warehouse_variant_field, (val) => {
			me.state.opening_warehouse = val || "";
			me._clear_error("warehouse-v");
		});

		this.posting_date_field = frappe.ui.form.make_control({
			df: { fieldtype: "Date", placeholder: "Leave blank for today" },
			parent: this.$page.find("#itc-posting-date-field"),
			render_input: true,
		});
		this.posting_date_field.$input.on("change", () => {
			me.state.posting_date = me.posting_date_field.get_value() || "";
			me._toggle_posting_date_info();
		});

		this.desc_field = frappe.ui.form.make_control({
			df: { fieldtype: "Small Text", placeholder: "Optional description..." },
			parent: this.$page.find("#itc-description-field"),
			render_input: true,
		});
		this.desc_field.$input.on("input change", () => {
			me.state.description = me.desc_field.get_value() || "";
		});
	}

	// ── Bind events ──
	_bind_events() {
		const me = this;

		this.$page.find(".itc-creation-btn").on("click", function () {
			const $btn = $(this);
			const type = $btn.data("type");
			$btn.siblings().removeClass("active").attr("aria-checked", "false");
			$btn.addClass("active").attr("aria-checked", "true");
			me.state.creation_type = type;
			me._toggle_creation_mode();
		});

		this.$page.find(".itc-toggle-btn").on("click", function () {
			const $btn = $(this);
			const target = $btn.data("target");
			const value = $btn.data("value");
			$btn.siblings().removeClass("active").attr("aria-checked", "false");
			$btn.addClass("active").attr("aria-checked", "true");
			if (target === "company") {
				me.state.company_code_type = value;
				me._fetch_company_code();
			} else {
				me.state.category_code_type = value;
				me._fetch_category_code();
			}
		});

		this.$page.find("#itc-has-variant").on("change", function () {
			me.state.has_variant = $(this).is(":checked");
			me.$page.find(".itc-variant-options").toggle(me.state.has_variant);
			me._toggle_stock_mode();
			me._refresh_meta_summaries();
			me._update_preview();
			if (me.state.has_variant && me.variant_rows.length === 0) {
				me._add_variant_row();
			}
		});

		this.$page.find(".itc-source-tab").on("click", function () {
			const source = $(this).data("source");
			me.state.variant_source = source;
			me.$page.find(".itc-source-tab").removeClass("active").attr("aria-selected", "false");
			$(this).addClass("active").attr("aria-selected", "true");
			me.variant_rows = [];
			me.$page.find("#itc-variant-grid").empty();
			me._add_variant_row();
			me._refresh_meta_summaries();
		});

		this.$page.find("#itc-maintain-stock").on("change", function () {
			me.state.maintain_stock = $(this).is(":checked") ? 1 : 0;
			me._toggle_stock_mode();
			me._refresh_meta_summaries();
		});

		this.$page.find("#itc-add-variant").on("click", () => me._add_variant_row());

		this.$page.find("#itc-btn-create").on("click", () => me._create_item());
		this.$page.find("#itc-btn-reset").on("click", () => me._reset());

		this.$page.find("#itc-view-item").on("click", () => {
			if (me._last_template_item) {
				frappe.set_route("Form", "Item", me._last_template_item);
			} else if (me._last_created_item) {
				frappe.set_route("Form", "Item", me._last_created_item);
			}
		});
		this.$page.find("#itc-create-another").on("click", () => me._reset());
	}

	// ── Item Name typeahead (duplicate detection) ──
	_setup_item_name_typeahead() {
		const me = this;
		const $input = this.item_name_field.$input;
		const $dropdown = this.$page.find("#itc-item-name-suggestions");
		this._suggest_timer = null;
		this._suggest_results = [];
		this._suggest_highlight = -1;
		this._suggest_busy = false;

		$input.on("input.itcsuggest", () => {
			const q = ($input.val() || "").trim();
			clearTimeout(me._suggest_timer);
			if (q.length < 3) {
				me._hide_suggestions();
				return;
			}
			me._suggest_timer = setTimeout(() => me._fetch_suggestions(q), 300);
		});

		$input.on("keydown.itcsuggest", (e) => {
			if (!$dropdown.is(":visible") || !me._suggest_results.length) return;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				me._move_highlight(1);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				me._move_highlight(-1);
			} else if (e.key === "Enter" && me._suggest_highlight >= 0) {
				e.preventDefault();
				me._open_existing_item_modal(me._suggest_results[me._suggest_highlight]);
			} else if (e.key === "Escape") {
				me._hide_suggestions();
			}
		});

		$(document).on("click.itcsuggest", (e) => {
			if (!$dropdown.is(":visible")) return;
			if ($(e.target).closest("#itc-item-name-suggestions, #itc-item-name-field").length === 0) {
				me._hide_suggestions();
			}
		});
	}

	_fetch_suggestions(q) {
		const me = this;
		if (this._suggest_busy) return;
		this._suggest_busy = true;
		frappe.call({
			method: "item_creator.item_creator.doctype.ts_item_creator.ts_item_creator.search_existing_items",
			args: { query: q, limit: 10 },
			callback: (r) => {
				me._suggest_busy = false;
				const rows = (r && r.message) || [];
				me._render_suggestions(rows);
			},
			error: () => {
				me._suggest_busy = false;
				me._hide_suggestions();
			},
		});
	}

	_render_suggestions(rows) {
		const $dropdown = this.$page.find("#itc-item-name-suggestions");
		const esc = frappe.utils.escape_html;
		this._suggest_results = rows;
		this._suggest_highlight = -1;
		if (!rows.length) {
			$dropdown.hide().empty();
			return;
		}
		const header = `<div class="itc-suggest-header">${rows.length} similar item${rows.length > 1 ? "s" : ""} already exist${rows.length === 1 ? "s" : ""} — click to review:</div>`;
		const items = rows.map((r, i) => {
			const usage = r.usage_count > 0
				? `<span class="itc-suggest-usage">Used in ${r.usage_count} PO${r.usage_count > 1 ? "s" : ""}</span>`
				: `<span class="itc-suggest-usage itc-suggest-usage-zero">Not used yet</span>`;
			const brand = r.brand ? ` · Brand: ${esc(r.brand)}` : "";
			const group = r.item_group ? esc(r.item_group) : "—";
			return `
				<div class="itc-suggest-row" data-idx="${i}" role="option" tabindex="-1">
					<div class="itc-suggest-row-main">
						<div class="itc-suggest-row-code">${esc(r.item_code)}</div>
						<div class="itc-suggest-row-name">${esc(r.item_name || "")}</div>
						<div class="itc-suggest-row-meta">${group}${brand}</div>
					</div>
					${usage}
				</div>
			`;
		}).join("");
		const footer = `<div class="itc-suggest-footer">Press Esc or click outside to dismiss · keep typing if your item is different</div>`;
		$dropdown.html(header + items + footer).show();

		const me = this;
		$dropdown.find(".itc-suggest-row").on("click", function () {
			const idx = parseInt($(this).attr("data-idx"));
			me._open_existing_item_modal(me._suggest_results[idx]);
		});
		$dropdown.find(".itc-suggest-row").on("mouseenter", function () {
			me._suggest_highlight = parseInt($(this).attr("data-idx"));
			me._apply_highlight();
		});
	}

	_move_highlight(delta) {
		if (!this._suggest_results.length) return;
		this._suggest_highlight = (this._suggest_highlight + delta + this._suggest_results.length) % this._suggest_results.length;
		this._apply_highlight();
	}

	_apply_highlight() {
		const $dropdown = this.$page.find("#itc-item-name-suggestions");
		$dropdown.find(".itc-suggest-row").removeClass("itc-suggest-active");
		if (this._suggest_highlight >= 0) {
			const $row = $dropdown.find(`.itc-suggest-row[data-idx="${this._suggest_highlight}"]`);
			$row.addClass("itc-suggest-active");
			const dEl = $dropdown.get(0);
			const rEl = $row.get(0);
			if (dEl && rEl) {
				const rTop = rEl.offsetTop;
				const rBot = rTop + rEl.offsetHeight;
				if (rTop < dEl.scrollTop) dEl.scrollTop = rTop;
				else if (rBot > dEl.scrollTop + dEl.clientHeight) dEl.scrollTop = rBot - dEl.clientHeight;
			}
		}
	}

	_hide_suggestions() {
		this.$page.find("#itc-item-name-suggestions").hide().empty();
		this._suggest_results = [];
		this._suggest_highlight = -1;
	}

	_open_existing_item_modal(row) {
		const esc = frappe.utils.escape_html;
		const me = this;
		this._hide_suggestions();
		const usage_line = row.usage_count > 0
			? `<b>${row.usage_count}</b> Purchase Order${row.usage_count > 1 ? "s" : ""}`
			: `<span style="color:var(--text-muted,#64748b)">Not used in any Purchase Order yet</span>`;
		const d = new frappe.ui.Dialog({
			title: "Similar Item Already Exists",
			fields: [
				{
					fieldtype: "HTML",
					options: `
						<div class="itc-existing-item-card">
							<div class="itc-existing-item-code">${esc(row.item_code)}</div>
							<div class="itc-existing-item-name">${esc(row.item_name || "")}</div>
							<table class="itc-existing-item-meta">
								<tr><td>Item Group</td><td>${esc(row.item_group || "—")}</td></tr>
								<tr><td>Brand</td><td>${esc(row.brand || "—")}</td></tr>
								<tr><td>Stock UOM</td><td>${esc(row.stock_uom || "—")}</td></tr>
								<tr><td>Usage</td><td>${usage_line}</td></tr>
							</table>
							<div class="itc-existing-item-hint">If this is the item you meant to use, open it. Otherwise close this dialog and refine your name.</div>
						</div>
					`,
				},
			],
			primary_action_label: "Open This Item",
			primary_action() {
				d.hide();
				frappe.set_route("Form", "Item", row.item_code);
			},
			secondary_action_label: "Continue — my item is different",
			secondary_action() {
				d.hide();
				me.item_name_field.$input.focus();
			},
		});
		d.show();
	}

	// ── Section state helpers ──
	_open_section(key) {
		const $sec = this.$page.find(`[data-section="${key}"]`);
		if ($sec.length && !$sec.prop("open")) {
			$sec.prop("open", true);
		}
	}

	_scroll_to_error($field) {
		if (!$field || !$field.length) return;
		try {
			$field[0].scrollIntoView({ behavior: "smooth", block: "center" });
		} catch (e) {
			// older browsers
			$("html, body").animate({ scrollTop: $field.offset().top - 80 }, 300);
		}
		setTimeout(() => {
			const $input = $field.find("input, select, textarea").first();
			if ($input.length) $input.focus();
		}, 350);
	}

	_set_error(field_key, message) {
		const $err = this.$page.find(`#itc-err-${field_key}`);
		$err.text(message || "").toggleClass("show", !!message);
		const $grp = $err.closest(".itc-form-group");
		$grp.toggleClass("itc-has-error", !!message);
	}

	_clear_error(field_key) {
		this._set_error(field_key, "");
	}

	_clear_all_errors() {
		this.$page.find(".itc-field-error").text("").removeClass("show");
		this.$page.find(".itc-form-group").removeClass("itc-has-error");
		this.$page.find("#itc-error-banner").hide();
	}

	_show_banner(message) {
		this.$page.find("#itc-error-banner-text").text(message);
		this.$page.find("#itc-error-banner").show();
	}

	// ── Toggle stock mode (variant vs standalone) ──
	_toggle_stock_mode() {
		const is_variant = this.state.has_variant;
		const has_stock = !!this.state.maintain_stock;
		this.$page.find(".itc-standalone-stock").toggle(!is_variant && has_stock);
		this.$page.find(".itc-variant-stock").toggle(is_variant && has_stock);
		if (!has_stock) {
			this.$page.find(".itc-stock-fields").hide();
		}
	}

	// ── Toggle Regular vs Fixed Asset mode ──
	_toggle_creation_mode() {
		const is_asset = this.state.creation_type === "Fixed Asset";

		this.$page.find(".itc-regular-only").toggle(!is_asset);
		this.$page.find(".itc-asset-only").toggle(is_asset);
		this.$page.find(".itc-company-code-type").toggle(!is_asset);

		if (is_asset) {
			this.state.has_variant = false;
			this.state.maintain_stock = 0;
			this.state.company_code_type = "Character";
			this.$page.find("#itc-has-variant").prop("checked", false);
			this.$page.find(".itc-variant-options").hide();
			this.$page.find(".itc-toggle-btn[data-target='company']")
				.removeClass("active").attr("aria-checked", "false");
			this.$page.find(".itc-toggle-btn[data-target='company'][data-value='Character']")
				.addClass("active").attr("aria-checked", "true");
			if (this.state.company) {
				this._fetch_company_code();
			}
			if (!this.state.fiscal_year) {
				this._fetch_current_fiscal_year();
			}
		} else {
			this.state.maintain_stock = 1;
			this.$page.find("#itc-maintain-stock").prop("checked", true);
		}

		this._refresh_meta_summaries();
		this._update_preview();
	}

	// ── Fiscal Year helpers ──
	_fetch_current_fiscal_year() {
		const me = this;
		frappe.call({
			method: "item_creator.item_creator.doctype.ts_item_creator.ts_item_creator.get_current_fiscal_year",
			callback: (r) => {
				if (r.message && r.message.fiscal_year) {
					me.state.fiscal_year = r.message.fiscal_year;
					me.state.fiscal_year_short = r.message.fiscal_year_short || "";
					if (me.fiscal_year_field) {
						me.fiscal_year_field.set_value(r.message.fiscal_year);
					}
					me._update_badge("#itc-fy-short", me.state.fiscal_year_short);
					me._fetch_serial_preview();
					me._refresh_meta_summaries();
				}
			},
		});
	}

	_derive_fy_short() {
		if (!this.state.fiscal_year) {
			this.state.fiscal_year_short = "";
			this._update_badge("#itc-fy-short", "");
			this._refresh_meta_summaries();
			this._update_preview();
			return;
		}
		const m = String(this.state.fiscal_year).match(/^(\d{4})-(\d{4})$/);
		if (m) {
			this.state.fiscal_year_short = m[1].slice(2) + "-" + m[2].slice(2);
			this._update_badge("#itc-fy-short", this.state.fiscal_year_short);
			this._fetch_serial_preview();
			this._refresh_meta_summaries();
			return;
		}
		// Fallback: read Fiscal Year doc
		const me = this;
		frappe.db.get_value("Fiscal Year", this.state.fiscal_year,
			["year_start_date", "year_end_date"], (r) => {
				if (r && r.year_start_date && r.year_end_date) {
					me.state.fiscal_year_short =
						String(r.year_start_date).slice(2, 4) + "-" +
						String(r.year_end_date).slice(2, 4);
				} else {
					me.state.fiscal_year_short = me.state.fiscal_year;
				}
				me._update_badge("#itc-fy-short", me.state.fiscal_year_short);
				me._fetch_serial_preview();
				me._refresh_meta_summaries();
			});
	}

	// ── Variant row management ──
	_add_variant_row() {
		const me = this;
		const idx = this._variant_row_counter++;
		const row = {
			id: idx, brand: "", brand_code: "",
			variant: "", variant_code: "",
			valuation_rate: 0, standard_rate: 0,
			opening_stock: 0, description: "",
		};
		this.variant_rows.push(row);

		const is_brand = this.state.variant_source === "Brand";
		const link_label = is_brand ? "Brand" : "Custom Variant";
		const $row = $(`
			<div class="itc-variant-row-card" data-row-id="${idx}">
				<div class="itc-variant-row-header">
					<span class="itc-variant-row-num">${this.variant_rows.length}</span>
					<span class="itc-variant-row-code-badge" id="itc-vrow-code-${idx}">---</span>
					<button type="button" class="itc-variant-row-remove" data-row-id="${idx}" aria-label="Remove variant" title="Remove variant">
						<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
					</button>
				</div>
				<div class="itc-variant-row-body">
					<div class="itc-vrow-fields-grid">
						<div class="itc-vrow-field">
							<label class="itc-label-sm">${link_label} <span class="itc-req">*</span></label>
							<div id="itc-vrow-link-${idx}"></div>
						</div>
						<div class="itc-vrow-field">
							<label class="itc-label-sm">Valuation Rate</label>
							<div id="itc-vrow-valuation-${idx}"></div>
						</div>
						<div class="itc-vrow-field">
							<label class="itc-label-sm">Selling Rate</label>
							<div id="itc-vrow-selling-${idx}"></div>
						</div>
						<div class="itc-vrow-field">
							<label class="itc-label-sm">Opening Stock</label>
							<div id="itc-vrow-stock-${idx}"></div>
						</div>
					</div>
					<div class="itc-vrow-desc">
						<label class="itc-label-sm">Description</label>
						<div id="itc-vrow-desc-${idx}"></div>
					</div>
				</div>
			</div>
		`);

		this.$page.find("#itc-variant-grid").append($row);

		// Link control (Brand or TS Variant)
		if (is_brand) {
			const brand_ctrl = frappe.ui.form.make_control({
				df: { fieldtype: "Link", options: "Brand", placeholder: "Select Brand..." },
				parent: $row.find(`#itc-vrow-link-${idx}`),
				render_input: true,
			});
			this._on_link_value(brand_ctrl, (val) => {
				row.brand = val || "";
				row.variant = "";
				row.variant_code = "";
				if (val) {
					frappe.db.get_value("Brand", val, "brand_code", (r) => {
						row.brand_code = r ? (r.brand_code || "") : "";
						$row.find(`#itc-vrow-code-${idx}`).text(row.brand_code || "---");
						if (!row.brand_code) {
							me._prompt_set_code("Brand", val, "brand_code", (code) => {
								row.brand_code = code;
								$row.find(`#itc-vrow-code-${idx}`).text(code);
								me._update_preview();
								me._refresh_meta_summaries();
							});
						} else {
							me._update_preview();
							me._refresh_meta_summaries();
						}
					});
				} else {
					row.brand_code = "";
					$row.find(`#itc-vrow-code-${idx}`).text("---");
					me._update_preview();
					me._refresh_meta_summaries();
				}
			});
			row._brand_ctrl = brand_ctrl;
		} else {
			const variant_ctrl = frappe.ui.form.make_control({
				df: {
					fieldtype: "Link",
					options: "TS Variant",
					placeholder: "Select Variant...",
					get_query: () => ({ filters: { enabled: 1 } }),
				},
				parent: $row.find(`#itc-vrow-link-${idx}`),
				render_input: true,
			});
			this._on_link_value(variant_ctrl, (val) => {
				row.variant = val || "";
				row.brand = "";
				row.brand_code = "";
				if (val) {
					// Use the whitelisted helper, not a bare frappe.db.get_value (permission-safe)
					frappe.call({
						method: "item_creator.item_creator.doctype.ts_item_creator.ts_item_creator.get_variant_code",
						args: { name: val },
						callback: (r) => {
							row.variant_code = (r && r.message && r.message.variant_code) || "";
							$row.find(`#itc-vrow-code-${idx}`).text(row.variant_code || "---");
							me._update_preview();
							me._refresh_meta_summaries();
						},
					});
				} else {
					row.variant_code = "";
					$row.find(`#itc-vrow-code-${idx}`).text("---");
					me._update_preview();
					me._refresh_meta_summaries();
				}
			});
			row._variant_ctrl = variant_ctrl;
		}

		const val_ctrl = frappe.ui.form.make_control({
			df: { fieldtype: "Currency", placeholder: "0.00" },
			parent: $row.find(`#itc-vrow-valuation-${idx}`),
			render_input: true,
		});
		val_ctrl.$input.on("change", () => {
			row.valuation_rate = flt(val_ctrl.get_value());
			me._refresh_meta_summaries();
		});

		const sell_ctrl = frappe.ui.form.make_control({
			df: { fieldtype: "Currency", placeholder: "0.00" },
			parent: $row.find(`#itc-vrow-selling-${idx}`),
			render_input: true,
		});
		sell_ctrl.$input.on("change", () => {
			row.standard_rate = flt(sell_ctrl.get_value());
		});

		const stock_ctrl = frappe.ui.form.make_control({
			df: { fieldtype: "Float", placeholder: "0" },
			parent: $row.find(`#itc-vrow-stock-${idx}`),
			render_input: true,
		});
		stock_ctrl.$input.on("change", () => {
			row.opening_stock = flt(stock_ctrl.get_value());
			me._toggle_posting_date_row();
			me._refresh_meta_summaries();
		});

		const desc_ctrl = frappe.ui.form.make_control({
			df: { fieldtype: "Small Text", placeholder: "Optional description..." },
			parent: $row.find(`#itc-vrow-desc-${idx}`),
			render_input: true,
		});
		desc_ctrl.$input.on("input change", () => {
			row.description = desc_ctrl.get_value() || "";
		});

		$row.find(".itc-variant-row-remove").on("click", function () {
			const rid = parseInt($(this).data("row-id"));
			me.variant_rows = me.variant_rows.filter((r) => r.id !== rid);
			$row.remove();
			me._renumber_variant_rows();
			me._update_preview();
			me._refresh_meta_summaries();
		});

		this._update_preview();
		this._refresh_meta_summaries();
	}

	_renumber_variant_rows() {
		this.$page.find(".itc-variant-row-card").each(function (i) {
			$(this).find(".itc-variant-row-num").text(i + 1);
		});
	}

	// ── Fetch master-data codes ──
	_fetch_company_code() {
		if (!this.state.company) {
			this.state.company_code = "";
			this._update_badge("#itc-company-code", "");
			this._refresh_meta_summaries();
			this._update_preview();
			return;
		}
		const field = this.state.company_code_type === "Numerical" ? "company_num_code" : "company_code";
		frappe.db.get_value("Company", this.state.company, field, (r) => {
			this.state.company_code = r ? (r[field] || "") : "";
			this._update_badge("#itc-company-code", this.state.company_code);
			if (!this.state.company_code) {
				this._prompt_set_code("Company", this.state.company, field, (code) => {
					this.state.company_code = code;
					this._update_badge("#itc-company-code", code);
					this._fetch_serial_preview();
					this._refresh_meta_summaries();
				});
			} else {
				this._fetch_serial_preview();
				this._refresh_meta_summaries();
			}
		});
	}

	_fetch_category_code() {
		if (!this.state.item_group) {
			this.state.category_code = "";
			this._update_badge("#itc-category-code", "");
			this._refresh_meta_summaries();
			this._update_preview();
			return;
		}
		if (this._category_code_fetching) return;
		this._category_code_fetching = true;
		const field = this.state.category_code_type === "Numerical" ? "category_num_code" : "category_code";
		frappe.db.get_value("Item Group", this.state.item_group, field, (r) => {
			this._category_code_fetching = false;
			this.state.category_code = r ? (r[field] || "") : "";
			this._update_badge("#itc-category-code", this.state.category_code);
			if (!this.state.category_code) {
				this._prompt_set_code("Item Group", this.state.item_group, field, (code) => {
					this.state.category_code = code;
					this._update_badge("#itc-category-code", code);
					this._fetch_serial_preview();
					this._refresh_meta_summaries();
				});
			} else {
				this._fetch_serial_preview();
				this._refresh_meta_summaries();
			}
		});
	}

	// ── Prompt to set missing master-data code ──
	_prompt_set_code(doctype, name, fieldname, callback) {
		if (this._prompt_open) return;
		this._prompt_open = true;
		const is_num = fieldname.includes("num");
		const label = is_num ? "Numerical Code (e.g. 01)" : "Character Code (e.g. ABC)";
		const me = this;
		const esc = frappe.utils.escape_html;
		const d = new frappe.ui.Dialog({
			title: `Set ${doctype} Code`,
			fields: [
				{
					fieldtype: "HTML",
					options: `<div class="itc-prompt-info">
						<b>${esc(name)}</b> does not have a <b>${esc(fieldname.replace(/_/g, " "))}</b> set.
						Enter one below to continue.
					</div>`,
				},
				{
					fieldname: "code_value",
					fieldtype: "Data",
					label: label,
					reqd: 1,
					description: is_num ? "1-5 digits (e.g. 01)" : "1-5 alphanumeric (e.g. ABC, RM)",
				},
			],
			primary_action_label: "Save Code",
			primary_action(values) {
				let code = (values.code_value || "").trim().toUpperCase();
				if (!is_num && !/^[A-Z0-9]{1,5}$/.test(code)) {
					frappe.msgprint("Code must be 1-5 alphanumeric characters.");
					return;
				}
				if (is_num && !/^[0-9]{1,5}$/.test(code)) {
					frappe.msgprint("Numerical code must be 1-5 digits.");
					return;
				}
				frappe.call({
					method: "frappe.client.set_value",
					args: { doctype: doctype, name: name, fieldname: fieldname, value: code },
					callback(r) {
						if (r.message) {
							d.hide();
							frappe.show_alert({ message: `${doctype} code set to <b>${esc(code)}</b>`, indicator: "green" });
							callback(code);
						}
					},
				});
			},
		});
		d.onhide = () => { me._prompt_open = false; };
		d.show();
		setTimeout(() => d.fields_dict.code_value.$input.focus(), 200);
	}

	_fetch_serial_preview() {
		if (this.state.creation_type === "Fixed Asset") {
			if (!this.state.company || !this.state.fiscal_year) {
				this._update_preview();
				return;
			}
			frappe.call({
				method: "item_creator.item_creator.doctype.ts_item_creator.ts_item_creator.get_next_asset_serial_preview",
				args: { company: this.state.company, fiscal_year: this.state.fiscal_year },
				callback: (r) => {
					if (r.message) {
						this.state.serial_number = r.message;
						this._update_badge("#itc-serial-code", this.state.serial_number);
						this._update_preview();
						this._refresh_meta_summaries();
					}
				},
			});
			return;
		}
		if (!this.state.company || !this.state.item_group) {
			this._update_preview();
			return;
		}
		frappe.call({
			method: "item_creator.item_creator.doctype.ts_item_creator.ts_item_creator.get_next_serial_preview",
			args: { company: this.state.company, item_group: this.state.item_group },
			callback: (r) => {
				if (r.message) {
					this.state.serial_number = r.message;
					this._update_badge("#itc-serial-code", this.state.serial_number);
					this._update_preview();
					this._refresh_meta_summaries();
				}
			},
		});
	}

	// ── Live preview ──
	_update_badge(selector, value) {
		const $badge = this.$page.find(selector);
		$badge.text(value || "---");
		if (value) {
			$badge.addClass("itc-active");
			setTimeout(() => $badge.removeClass("itc-active"), 300);
		}
	}

	_update_preview() {
		const esc = frappe.utils.escape_html;
		const $code = this.$page.find("#itc-live-code");
		const $sub = this.$page.find("#itc-preview-sub");

		if (this.state.creation_type === "Fixed Asset") {
			const cc = this.state.company_code;
			const fy = this.state.fiscal_year_short;
			const ser = this.state.serial_number;
			if (!cc || !fy) {
				$code.html('<span class="itc-code-placeholder">Select Company &amp; Fiscal Year to begin</span>');
				$sub.text("");
				return;
			}
			$code.html(
				`<span class="itc-c1">FA</span><span class="itc-csep">-</span>` +
				`<span class="itc-c2">${esc(cc)}</span><span class="itc-csep">-</span>` +
				`<span class="itc-c3">${esc(fy)}</span><span class="itc-csep">-</span>` +
				`<span class="itc-c4">${esc(ser || "_____")}</span>`
			);
			$sub.text("Fixed Asset · FY " + fy);
			return;
		}

		const cc = this.state.company_code;
		const cat = this.state.category_code;
		const ser = this.state.serial_number;

		if (!cc || !cat) {
			$code.html('<span class="itc-code-placeholder">Select Company &amp; Category to begin</span>');
			$sub.text("");
			return;
		}

		if (this.state.has_variant && this.variant_rows.length > 0) {
			const count = this.variant_rows.length;
			const first_code = this.variant_rows[0].brand_code || this.variant_rows[0].variant_code || "___";
			$code.html(
				`<span class="itc-c2">${esc(cc)}</span><span class="itc-csep">-</span>` +
				`<span class="itc-c1">${esc(cat)}</span><span class="itc-csep">-</span>` +
				`<span class="itc-c4">${esc(ser || "___")}</span><span class="itc-csep">-</span>` +
				`<span class="itc-c3">${esc(first_code)}</span>` +
				(count > 1 ? `<span class="itc-cmore">+${count - 1} more</span>` : "")
			);
			$sub.text(`Template + ${count} variant${count > 1 ? "s" : ""}`);
		} else {
			$code.html(
				`<span class="itc-c2">${esc(cc)}</span><span class="itc-csep">-</span>` +
				`<span class="itc-c1">${esc(cat)}</span><span class="itc-csep">-</span>` +
				`<span class="itc-c4">${esc(ser || "___")}</span>`
			);
			$sub.text("Standalone item");
		}
	}

	// ── Section meta summaries (shown in collapsed summary line) ──
	_refresh_meta_summaries() {
		const s = this.state;
		const $b = this.$page.find("#itc-meta-basics");
		const $d = this.$page.find("#itc-meta-details");
		const $v = this.$page.find("#itc-meta-variants");
		const $st = this.$page.find("#itc-meta-stock");
		const $o = this.$page.find("#itc-meta-opening");

		// Basics
		if (s.creation_type === "Fixed Asset") {
			const fy = s.fiscal_year_short || "?";
			const cc = s.company_code || "?";
			const ac = s.asset_category || "?";
			$b.text(s.company ? `${cc} · ${ac} · FY ${fy}` : "Select to begin");
		} else {
			const cc = s.company_code || "?";
			const cat = s.category_code || "?";
			const ser = s.serial_number || "#";
			$b.text(s.company && s.item_group ? `${cc} · ${cat} · #${ser}` : "Select to begin");
		}
		this._set_section_status("basics", this._validate_basics(true));

		// Details
		const name = s.item_name || "(unnamed)";
		const uom = s.stock_uom || "?";
		const hsn = s.gst_hsn_code || "?";
		$d.text(`${name} · ${uom} · HSN ${hsn}`);
		this._set_section_status("details", this._validate_details(true));

		// Variants
		if (s.has_variant && this.variant_rows.length) {
			const valid_rows = this.variant_rows.filter((r) => r.brand_code || r.variant_code).length;
			$v.text(`${this.variant_rows.length} variant${this.variant_rows.length > 1 ? "s" : ""} (${s.variant_source})`);
			this._set_section_status("variants", valid_rows === this.variant_rows.length);
		} else {
			$v.text("No variants");
			this._set_section_status("variants", true);
		}

		// Stock
		if (!s.maintain_stock) {
			$st.text("Not tracked");
		} else if (s.has_variant) {
			$st.text("Tracked (per variant)");
		} else {
			const v = flt(s.valuation_rate);
			$st.text(v > 0 ? `Tracked · Val ${this._fmt_currency(v)}` : "Tracked");
		}
		this._set_section_status("stock", true);

		// Opening
		if (s.has_variant) {
			const tot = this.variant_rows.reduce((sum, r) => sum + flt(r.opening_stock), 0);
			$o.text(tot > 0 ? `${tot} ${s.stock_uom || "units"} across variants` : "None");
		} else {
			const q = flt(s.opening_stock);
			$o.text(q > 0 ? `${q} ${s.stock_uom || "units"} @ ${s.opening_warehouse || "?"}` : "None");
		}
		this._set_section_status("opening", true);
	}

	_set_section_status(key, ok) {
		const $s = this.$page.find(`#itc-status-${key}`);
		$s.toggleClass("itc-status-ok", !!ok);
	}

	// Format using the site's default currency — never a hardcoded symbol
	_fmt_currency(value) {
		const v = flt(value);
		try {
			return format_currency(v, frappe.boot.sysdefaults.currency);
		} catch (e) {
			return String(v);
		}
	}

	// ── Validation (returns true if no errors when silent=true; sets inline errors when silent=false) ──
	_validate_basics(silent) {
		const s = this.state;
		let ok = true;
		if (!s.company) {
			if (!silent) this._set_error("company", "Required");
			ok = false;
		} else if (!s.company_code) {
			if (!silent) this._set_error("company", "Company code not set");
			ok = false;
		}
		if (s.creation_type === "Fixed Asset") {
			if (!s.fiscal_year) { if (!silent) this._set_error("fy", "Required"); ok = false; }
			else if (!s.fiscal_year_short) { if (!silent) this._set_error("fy", "Could not derive FY short form"); ok = false; }
			if (!s.asset_category) { if (!silent) this._set_error("asset-cat", "Required"); ok = false; }
		} else {
			if (!s.item_group) {
				if (!silent) this._set_error("category", "Required");
				ok = false;
			} else if (!s.category_code) {
				if (!silent) this._set_error("category", "Category code not set");
				ok = false;
			}
		}
		return ok;
	}

	_validate_details(silent) {
		const s = this.state;
		let ok = true;
		if (!s.stock_uom) { if (!silent) this._set_error("uom", "Required"); ok = false; }
		if (!s.gst_hsn_code) { if (!silent) this._set_error("hsn", "Required for GST"); ok = false; }
		return ok;
	}

	_validate_variants(silent) {
		const s = this.state;
		if (!s.has_variant) return true;
		if (this.variant_rows.length === 0) {
			if (!silent) this._show_banner("Add at least one variant or disable Variants.");
			return false;
		}
		for (let i = 0; i < this.variant_rows.length; i++) {
			const row = this.variant_rows[i];
			const v_code = row.brand_code || row.variant_code;
			if (!v_code) {
				if (!silent) this._show_banner(`Variant #${i + 1}: select a ${s.variant_source === "Brand" ? "Brand" : "Custom Variant"} with a valid code.`);
				return false;
			}
		}
		return true;
	}

	_validate_stock(silent) {
		const s = this.state;
		let ok = true;
		// Reject negative valuation rate (audit B-2)
		if (!s.has_variant && flt(s.valuation_rate) < 0) {
			if (!silent) this._set_error("valuation", "Cannot be negative");
			ok = false;
		}
		if (!s.has_variant && flt(s.opening_stock) < 0) {
			if (!silent) this._set_error("opening-stock", "Cannot be negative");
			ok = false;
		}
		return ok;
	}

	_validate_opening(silent) {
		const s = this.state;
		let ok = true;
		if (!s.maintain_stock) return true;
		if (!s.has_variant) {
			if (flt(s.opening_stock) > 0 && !s.opening_warehouse) {
				if (!silent) this._set_error("warehouse", "Required when opening stock is set");
				ok = false;
			}
			if (flt(s.opening_stock) > 0 && flt(s.valuation_rate) <= 0) {
				if (!silent) this._set_error("valuation", "Required when opening stock is set");
				ok = false;
			}
		} else {
			const has_opening = this.variant_rows.some((r) => flt(r.opening_stock) > 0);
			if (has_opening && !s.opening_warehouse) {
				if (!silent) this._set_error("warehouse-v", "Required when any variant has opening stock");
				ok = false;
			}
		}
		return ok;
	}

	// ── Validate all sections; expand offending section + scroll to first error ──
	_validate_all() {
		this._clear_all_errors();

		const checks = [
			{ key: "basics",   fn: () => this._validate_basics(false) },
			{ key: "details",  fn: () => this._validate_details(false) },
			{ key: "variants", fn: () => this._validate_variants(false) },
			{ key: "stock",    fn: () => this._validate_stock(false) },
			{ key: "opening",  fn: () => this._validate_opening(false) },
		];

		let first_fail = null;
		for (const c of checks) {
			if (!c.fn()) {
				if (!first_fail) first_fail = c.key;
			}
		}

		if (first_fail) {
			this._open_section(first_fail);
			const $first_err = this.$page.find(".itc-has-error").first();
			if ($first_err.length) {
				this._scroll_to_error($first_err);
			} else {
				const $sec = this.$page.find(`[data-section="${first_fail}"]`);
				this._scroll_to_error($sec);
			}
			if (!this.$page.find("#itc-error-banner").is(":visible")) {
				this._show_banner("Please fix the highlighted errors below.");
			}
			return false;
		}
		return true;
	}

	// ── Posting date helpers ──
	_toggle_posting_date_row() {
		const has_stock = flt(this.state.opening_stock) > 0 ||
			(this.state.has_variant && this.variant_rows.some((r) => flt(r.opening_stock) > 0));
		const show = has_stock && !!this.state.maintain_stock;
		this.$page.find("#itc-posting-date-row").toggle(show);
		if (!has_stock) {
			this.state.posting_date = "";
			if (this.posting_date_field) this.posting_date_field.set_value("");
			this.$page.find("#itc-posting-date-info").hide();
		}
	}

	_toggle_posting_date_info() {
		const val = this.state.posting_date;
		if (val) {
			const today = frappe.datetime.get_today();
			this.$page.find("#itc-posting-date-info").toggle(val !== today);
		} else {
			this.$page.find("#itc-posting-date-info").hide();
		}
	}

	// ── Create item ──
	_create_item() {
		const me = this;
		const s = me.state;
		const $btn = this.$page.find("#itc-btn-create");

		// Re-read live field values
		s.company = me.company_field.get_value() || s.company;
		s.stock_uom = me.uom_field.get_value() || "Nos";
		s.item_name = me.item_name_field.get_value() || s.item_name;
		s.gst_hsn_code = me.hsn_field.get_value() || s.gst_hsn_code;
		s.item_tax_template = me.tax_template_field.get_value() || "";
		s.description = me.desc_field.get_value() || "";

		if (s.creation_type === "Fixed Asset") {
			s.asset_category = me.asset_category_field.get_value() || s.asset_category;
			s.fiscal_year = me.fiscal_year_field.get_value() || s.fiscal_year;
		} else {
			s.item_group = me.category_field.get_value() || s.item_group;
			if (!s.has_variant) {
				s.valuation_rate = flt(me.valuation_rate_field.get_value());
				s.standard_rate = flt(me.standard_rate_field.get_value());
				s.opening_stock = flt(me.opening_stock_field.get_value());
				s.opening_warehouse = me.opening_warehouse_field.get_value() || "";
			} else {
				s.opening_warehouse = me.opening_warehouse_variant_field.get_value() || s.opening_warehouse;
			}
			s.posting_date = me.posting_date_field.get_value() || "";
		}

		if (!this._validate_all()) return;

		$btn.prop("disabled", true);
		this.$page.find("#itc-btn-create .itc-btn-label").text(this._is_approver ? "Creating..." : "Submitting...");

		const doc = {
			doctype: "TS Item Creator",
			creation_type: s.creation_type,
			company: s.company,
			company_code_type: s.company_code_type,
			company_code: s.company_code,
			item_group: s.creation_type === "Fixed Asset" ? "Fixed Assets" : s.item_group,
			category_code_type: s.category_code_type,
			category_code: s.creation_type === "Fixed Asset" ? (s.fiscal_year_short || "") : s.category_code,
			asset_category: s.asset_category || "",
			asset_category_code: "",
			fiscal_year: s.fiscal_year || "",
			fiscal_year_short: s.fiscal_year_short || "",
			has_variant: s.has_variant ? 1 : 0,
			variant_source: s.variant_source,
			item_name: s.item_name,
			stock_uom: s.stock_uom,
			gst_hsn_code: s.gst_hsn_code,
			item_tax_template: s.item_tax_template,
			maintain_stock: s.maintain_stock,
			opening_warehouse: s.opening_warehouse,
			posting_date: s.posting_date || "",
			description: s.description,
		};

		if (s.has_variant && me.variant_rows.length > 0) {
			doc.variants = me.variant_rows.map((row) => ({
				brand: row.brand || "",
				brand_code: row.brand_code || "",
				variant: row.variant || "",
				variant_code: row.variant_code || "",
				valuation_rate: row.valuation_rate || 0,
				standard_rate: row.standard_rate || 0,
				opening_stock: row.opening_stock || 0,
				description: row.description || "",
			}));
		} else {
			doc.valuation_rate = s.valuation_rate;
			doc.standard_rate = s.standard_rate;
			doc.opening_stock = s.opening_stock;
		}

		if (me._is_approver) {
			// Approver — one-step: insert then create the Item immediately (today's behavior)
			frappe.call({
				method: "frappe.client.insert",
				args: { doc: doc },
				callback(r) {
					if (r.message) {
						frappe.call({
							method: "run_doc_method",
							args: { dt: "TS Item Creator", dn: r.message.name, method: "create_item" },
							callback(res) {
								me._reset_btn($btn);
								if (res.message) {
									me._last_created_item = res.message.item_code;
									me._last_template_item = res.message.template_code || "";
									me._show_success(res.message);
								}
							},
							error() { me._reset_btn($btn); },
						});
					}
				},
				error() { me._reset_btn($btn); },
			});
		} else {
			// Non-approver — submit a request for approval (no Item created yet)
			frappe.call({
				method: "item_creator.item_creator.doctype.ts_item_creator.ts_item_creator.submit_item_request",
				args: { doc: doc },
				callback(r) {
					me._reset_btn($btn);
					if (r.message) {
						me._show_pending(r.message);
					}
				},
				error() { me._reset_btn($btn); },
			});
		}
	}

	_reset_btn($btn) {
		$btn.prop("disabled", false);
		this.$page.find("#itc-btn-create .itc-btn-label").text(this._is_approver ? "Create Item" : "Submit for Approval");
	}

	// ── Pending state (non-approver: request submitted, awaiting approval) ──
	_show_pending(result) {
		this.$page.find(".itc-card, .itc-preview-bar").hide();
		this.$page.find("#itc-success").addClass("is-pending").show();
		this.$page.find("#itc-success-title").text("Request Submitted — Pending Approval");
		this.$page.find("#itc-success-code").text(result.generated_item_code || result.name || "");
		this.$page.find("#itc-success-template").hide();
		this.$page.find("#itc-success-variant-list").hide();
		// No Item exists yet — hide the View Item action, keep "Create Another"
		this.$page.find("#itc-view-item").hide();
		frappe.show_alert({
			message: __("Item request submitted — pending approval."),
			indicator: "blue",
		});
		this._load_recent();
	}

	// ── Success state ──
	_show_success(result) {
		this.$page.find(".itc-card, .itc-preview-bar").hide();
		this.$page.find("#itc-success").removeClass("is-pending").show();
		this.$page.find("#itc-view-item").show();
		const esc = frappe.utils.escape_html;

		if (result.variant_items && result.variant_items.length > 0) {
			this.$page.find("#itc-success-title").text("Items Created Successfully!");
			this.$page.find("#itc-success-code").text(result.template_code + " (Template)");
			const $list = this.$page.find("#itc-success-variant-list").empty().show();
			result.variant_items.forEach((code) => {
				$list.append(
					`<div class="itc-success-variant-item">` +
					`<a href="/app/item/${encodeURIComponent(code)}">${esc(code)}</a>` +
					`</div>`
				);
			});
		} else {
			this.$page.find("#itc-success-title").text("Item Created Successfully!");
			this.$page.find("#itc-success-code").text(result.item_code);
			this.$page.find("#itc-success-variant-list").hide();
		}

		if (result.template_code) {
			this.$page.find("#itc-success-template").show();
			this.$page.find("#itc-success-template-link")
				.text(result.template_code)
				.attr("href", `/app/item/${encodeURIComponent(result.template_code)}`);
		} else {
			this.$page.find("#itc-success-template").hide();
		}

		this._load_recent();
	}

	// ── Reset ──
	_reset() {
		this.state = {
			creation_type: "Regular Item",
			asset_category: "", fiscal_year: "", fiscal_year_short: "",
			company: "", company_code_type: "Numerical", company_code: "",
			item_group: "", category_code_type: "Numerical", category_code: "",
			serial_number: "",
			has_variant: false, variant_source: "Brand",
			item_name: "", stock_uom: "Nos", gst_hsn_code: "", item_tax_template: "",
			maintain_stock: 1, valuation_rate: 0, standard_rate: 0,
			opening_stock: 0, opening_warehouse: "",
			posting_date: "", description: "",
		};
		this.variant_rows = [];
		this._variant_row_counter = 0;

		this.company_field.set_value("");
		this.category_field.set_value("");
		this.asset_category_field.set_value("");
		this.fiscal_year_field.set_value("");
		this.item_name_field.set_value("");
		this.uom_field.set_value("Nos");
		this.hsn_field.set_value("");
		this.tax_template_field.set_value("");
		this.valuation_rate_field.set_value("");
		this.standard_rate_field.set_value("");
		this.opening_stock_field.set_value("");
		this.opening_warehouse_field.set_value("");
		this.opening_warehouse_variant_field.set_value("");
		this.posting_date_field.set_value("");
		this.desc_field.set_value("");

		this.$page.find("#itc-has-variant").prop("checked", false);
		this.$page.find("#itc-maintain-stock").prop("checked", true);
		this.$page.find(".itc-variant-options").hide();
		this.$page.find(".itc-standalone-stock").show();
		this.$page.find(".itc-variant-stock").hide();
		this.$page.find("#itc-variant-grid").empty();
		this.$page.find("#itc-posting-date-row").hide();
		this.$page.find("#itc-posting-date-info").hide();

		// Reset Creation Type toggle to Regular
		this.$page.find(".itc-creation-btn").removeClass("active").attr("aria-checked", "false");
		this.$page.find(`.itc-creation-btn[data-type="Regular Item"]`).addClass("active").attr("aria-checked", "true");
		this.$page.find(".itc-regular-only").show();
		this.$page.find(".itc-asset-only").hide();
		this.$page.find(".itc-company-code-type").show();

		// Reset code-type toggles to Numerical
		this.$page.find(".itc-toggle-btn").removeClass("active").attr("aria-checked", "false");
		this.$page.find(".itc-toggle-btn[data-value='Numerical']").addClass("active").attr("aria-checked", "true");

		// Reset variant source tabs
		this.$page.find(".itc-source-tab").removeClass("active").attr("aria-selected", "false");
		this.$page.find(".itc-source-tab[data-source='Brand']").addClass("active").attr("aria-selected", "true");

		// Reset code badges + live code
		this.$page.find(".itc-code-badge").text("---");
		this.$page.find("#itc-live-code").html('<span class="itc-code-placeholder">Select Company &amp; Category to begin</span>');
		this.$page.find("#itc-preview-sub").text("");

		// Reset section open states
		this.$page.find("#itc-sec-basics").prop("open", true);
		this.$page.find("#itc-sec-details").prop("open", true);
		this.$page.find("#itc-sec-variants").prop("open", false);
		this.$page.find("#itc-sec-stock").prop("open", true);
		this.$page.find("#itc-sec-opening").prop("open", false);

		this._clear_all_errors();
		this._refresh_meta_summaries();

		this.$page.find(".itc-card, .itc-preview-bar").show();
		this.$page.find("#itc-success").removeClass("is-pending").hide();
	}

	// ── Recent items ──
	_load_recent() {
		const me = this;
		frappe.call({
			method: "item_creator.item_creator.doctype.ts_item_creator.ts_item_creator.get_my_recent_requests",
			args: { limit: 6 },
			callback: (r) => {
				const $list = me.$page.find("#itc-recent-list").empty();
				if (!r.message || !r.message.length) {
					me.$page.find("#itc-recent").hide();
					return;
				}
				me.$page.find("#itc-recent").show();
				const esc = frappe.utils.escape_html;
				r.message.forEach((item) => {
					const status_class = {
						Created: "status-created",
						"Pending Approval": "status-pending",
						Rejected: "status-rejected",
					}[item.status] || "status-draft";
					const $el = $(
						`<div class="itc-recent-item">
							<div class="itc-recent-item-info">
								<div class="itc-recent-item-code">${esc(item.generated_item_code || item.name)}</div>
								<div class="itc-recent-item-name">${esc(item.item_name || "")}</div>
							</div>
							<span class="itc-recent-item-status ${status_class}">${esc(item.status || "")}</span>
						</div>`
					);
					$el.on("click", () => {
						if (item.item_created && item.item_created.trim()) {
							const first_item = item.item_created.split(",")[0].trim();
							frappe.set_route("Form", "Item", first_item);
						} else {
							frappe.set_route("Form", "TS Item Creator", item.name);
						}
					});
					$list.append($el);
				});
			},
		});
	}
}
