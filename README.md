# Item Creator

A Frappe/ERPNext v15 app that generates **structured, server-side item codes** and creates the
Item for you, instead of letting every user hand-type whatever code they feel like.

Codes look like this:

```
{company code}-{category code}-{serial}      →   TM-GRN-001
```

Everything after the company/category prefix is assigned by the server from a per
company + category counter, so two people creating items at the same time cannot collide,
and nobody has to remember "was it `GRN-RICE-1` or `RICE-GRN-01` last time?".

**What you get**

- A guided creation page at `/app/item-creator` with a live preview of the code being built.
- Server-generated serials (`001`, `002`, …), one counter per Company + Item Group.
- **Duplicate detection** — as you type the item name it searches existing Items (including
  typo/word-order matches) and shows you what already exists before you create a near-duplicate.
- **Optional approval workflow** — ordinary users submit a request, approvers create the Item.
- **Variants** — one template Item plus many variant Items in a single submission, keyed off
  ERPNext Brands or a small custom variant master.
- **Fixed assets** — a separate code format `FA-{company}-{FY}-{serial}` for asset items.
- **Opening stock** — posted as a proper submitted Stock Entry into the warehouse and company
  you chose (optionally backdated), not as a loose value on the Item.

**The problem it solves:** inconsistent, hand-typed item codes and the duplicate item masters
that follow from them. Once installed, the normal way to create an Item becomes the Item Creator
page, and the code format is enforced by the server.

---

## 1. Requirements

| Requirement | Notes |
|---|---|
| Frappe Framework | v15 |
| ERPNext | v15 — required. The app creates **Items**, **Item Attributes** and **Stock Entries**, and reads Company / Item Group / Brand / Warehouse / UOM / Fiscal Year / Asset Category. |
| Python | 3.10 or newer (whatever your bench already runs for v15) |
| Database | MariaDB (the serial counter uses `SELECT … FOR UPDATE`) |

**India Compliance is _not_ required.** The page has an optional HSN/SAC field which is only
written to the Item when you fill it in. However, if your ERPNext setup makes HSN mandatory on
Item (for example because India Compliance is installed and configured), have your HSN codes
loaded **before** you start creating items — otherwise the Item insert will fail on ERPNext's
own validation, not on this app's.

---

## 2. Installation

From your bench directory:

```bash
# 1. fetch the app into the bench
bench get-app https://github.com/zxrrcpandey/Item-Creator.git

# 2. install it on a site
bench --site <site> install-app item_creator

# 3. apply schema
bench --site <site> migrate

# 4. build the app's JS/CSS bundle
bench build --app item_creator

# 5. reload
bench restart          # production
# bench start          # development
```

### What the install actually does

- Creates the 5 doctypes listed in [section 7](#7-doctypes-installed).
- Creates the desk page `item-creator`.
- Creates **5 Custom Fields** on existing ERPNext masters — these are where your codes live:

| DocType | Fieldname | Label | Purpose |
|---|---|---|---|
| Company | `company_code` | Company Code (ABC) | Character code, e.g. `TM` |
| Company | `company_num_code` | Company Code (123) | Numeric code, e.g. `01` |
| Item Group | `category_code` | Category Code (ABC) | Character code, e.g. `GRN` |
| Item Group | `category_num_code` | Category Code (123) | Numeric code, e.g. `04` |
| Brand | `brand_code` | Brand Code | Short code used as the variant suffix |

No existing data is modified, and no existing Item is renamed.

---

## 3. Post-install configuration (REQUIRED)

**Do this before anyone creates an item.** These codes are baked into every item code the app
generates, permanently. Changing `GRN` to `GRA` later does not rewrite the items already created
with `GRN` — you just end up with two prefixes for the same category. Decide the codes once, with
whoever owns the item master, then enter them.

### a) Company code

Go to **Company → (each company)** and set:

- **Company Code (ABC)** — a short character code. 1–5 alphanumeric characters, upper-cased;
  2–3 characters is the sweet spot. Example: `TM`.
- **Company Code (123)** — only if you intend to use numeric mode. 1–5 digits, e.g. `01`.

> **Set the character code even if you plan to use numeric mode.** The serial counter and the
> live preview on the page are keyed on the *character* code. If it is blank, the counter falls
> back to whatever code is being displayed, and if you add the character code later the counter
> starts a fresh sequence under the new key.

### b) Category code

Go to **Item Group → (each group you will create items under)** and set:

- **Category Code (ABC)** — e.g. `GRN`. Same 1–5 alphanumeric rule.
- **Category Code (123)** — only for numeric mode.

You only need to do this for the groups that will actually hold items — leaf groups, not the
`All Item Groups` container.

### c) Code format settings

Go to **TS Item Code Settings** (a Single doctype — search it in the awesomebar) and set:

| Field | Default | Meaning |
|---|---|---|
| Separator | `-` | Character placed between every segment. Changing it later only affects new codes. |
| Serial Number Digits | `3` | `3` → `001`, `4` → `0001`. Minimum enforced is 2. Fixed Asset codes always use 5 digits regardless of this setting. |
| Approver Roles | *(empty)* | Roles allowed to approve requests and to create items directly. When empty the app falls back to **System Manager**, **Item Manager**, **Stock Manager**. See [section 5](#5-approval-workflow). |
| Company-Category Counters | auto | The last serial issued for each company + category pair. **Auto-managed — do not hand-edit** unless you are deliberately seeding a starting number (see below). |

### Worked example

A company `Trustbit Mandi Pvt Ltd` with `Company Code (ABC) = TM`, separator `-`, 3 serial digits:

| Item Group | Category Code (ABC) | First generated code | Second |
|---|---|---|---|
| Grain | `GRN` | `TM-GRN-001` | `TM-GRN-002` |
| Packing Material | `PKG` | `TM-PKG-001` | `TM-PKG-002` |
| Consumable | `CON` | `TM-CON-001` | `TM-CON-002` |
| Spares & Tools | `SPR` | `TM-SPR-001` | `TM-SPR-002` |
| Services | `SRV` | `TM-SRV-001` | `TM-SRV-002` |

Each row counts independently — `TM-GRN-001` and `TM-PKG-001` both exist.

**Seeding an existing numbering series.** Counters start at 0, so the first item in a category is
`001`. If you already have items in this format and want to continue from, say, 250, open
**TS Item Code Settings → Company-Category Counters**, add a row with the company code, the
category code and `Last Serial = 250`. (As a safety net the app also skips forward past any serial
whose code already exists as an Item, so it will not overwrite an existing Item either way.)

---

## 4. Usage

Open **`/app/item-creator`**. The Item list's primary button is also redirected here, so
"create a new item" leads people to the guided page rather than the raw Item form.

The page is one scrolling form with collapsible sections and a sticky preview bar at the top
showing the code as it is assembled.

1. **Creation Type** — `Regular Item` or `Fixed Asset`.
2. **Company & Category** — pick the Company and the Item Group. Each has an `ABC` / `123` toggle
   choosing which of the two codes to use. The resolved codes appear as badges and the next serial
   is previewed live.
   - If the selected master has no code yet, the page pops a small dialog and lets you set it on
     the spot (it is written back to the Company / Item Group master).
   - The toggles default to `123`. If you only filled the ABC fields, flip both toggles to `ABC`.
3. **Item Details** — Item Name, Stock UOM, optional HSN/SAC, optional Item Tax Template
   (filtered to the selected company).
4. **Variants** *(regular items only)* — see below.
5. **Stock & Valuation** — Maintain Stock, Valuation Rate, Standard Selling Rate.
6. **Opening Stock** — quantity, warehouse (filtered to the selected company) and an optional
   posting date.

Then press the button at the bottom. It reads **Create Item** if you are an approver, or
**Submit for Approval** if you are not.

### The four creation types

| Type | How to get it | What gets created | Code |
|---|---|---|---|
| **Standard** | Regular Item, Variants off | One Item | `TM-GRN-001` |
| **Variant** | Regular Item, Variants on, one row | A template Item plus one variant Item | template `TM-GRN-001`, variant `TM-GRN-001-ABC` |
| **Multi-variant** | Regular Item, Variants on, several rows | One template Item plus one variant Item per row, in a single submission | `TM-GRN-001` + `TM-GRN-001-ABC`, `TM-GRN-001-XYZ`, … |
| **Fixed Asset** | Fixed Asset toggle | One non-stock Item with `is_fixed_asset = 1` | `FA-TM-25-26-00001` |

Variants use ERPNext's native variant system. The variant suffix comes either from a **Brand**
(`brand_code`) or from a **TS Variant** record (`variant_code`) — pick one with the tabs in the
Variants section. Each variant row carries its own valuation rate, selling rate, opening stock
and description. The app auto-creates and maintains a single Item Attribute named
**`TS Variant Code`** and adds each new code to it as an attribute value. If a template code
already exists as a normal (non-template) Item, the app refuses rather than mangling it; variant
codes that already exist are skipped, not duplicated.

### Duplicate detection

The Item Name field is a typeahead against your existing Item master. From the third character it
searches (debounced) in two stages:

1. **Token match** — every word you typed must appear somewhere in `item_name`, in any order.
   Typing `rice broken` finds `Broken Rice`.
2. **Fuzzy fallback** — if stage 1 finds fewer than five matches it runs a close-match pass over
   item names, so `brokn rce` still finds `Broken Rice`.

Results are ranked by how often the item has been used on Purchase Orders, so the item people
actually buy floats to the top. Clicking a suggestion opens a summary card with the item's group,
brand, UOM and usage count, and offers **Open This Item** or **Continue — my item is different**.
Disabled items are excluded. Nothing is blocked: it informs, it does not veto.

### Where opening stock goes

If Maintain Stock is on and a quantity is entered, the app posts a **submitted Stock Entry of type
Material Receipt** into the warehouse you selected, under the company you selected, dated the
posting date you gave (blank = today). It does **not** use ERPNext's `opening_stock` field on Item,
because that path ignores the chosen warehouse and books against the global default company. A
valuation rate is required when opening stock is entered. For multi-variant creation, one Stock
Entry is posted per variant row that has an opening quantity. Fixed Asset items are non-stock and
never get opening stock.

---

## 5. Approval workflow

Every submission is recorded as a **TS Item Creator** document with a status:

```
Draft ─► Pending Approval ─┬─► Created    (Item exists, linked on the record)
                           └─► Rejected   (reason recorded, no Item created)
```

| Who | What happens when they press the button |
|---|---|
| **Approver** | One step. The request is inserted and the Item is created immediately. Status goes straight to `Created`. |
| **Everyone else** | The request is inserted as `Pending Approval`. **No Item is created.** Approvers get a bell notification and an email. |

To action a queued request, an approver opens the **TS Item Creator** record (from the list, from
the notification, or from the "Recent" strip on the Item Creator page) and uses:

- **Approve** — creates the Item(s) and sets status `Created`.
- **Reject** — requires a reason; sets status `Rejected` and notifies the requester.

Who counts as an approver is the **Approver Roles** table in **TS Item Code Settings**. When it is
empty the app falls back to **System Manager**, **Item Manager**, **Stock Manager**. The check is
enforced server-side on every endpoint, and non-approvers cannot set the approval fields
(`status`, `approved_by`, `item_created`, …) by any route — the page only decides which button
label to show.

> ### ⚠️ If everyone is a System Manager, the queue never fires
>
> This is the single most common reason people report "the approval workflow does nothing".
> System Managers are approvers, and approvers self-create in one step — so on a site where every
> user has System Manager, every submission goes straight to `Created` and the queue stays empty.
>
> **To make it actually do something:**
> 1. Give day-to-day users a working role that is *not* an approver role — for example
>    **Stock User** or **Purchase User** — and **remove System Manager** from those users.
> 2. Set **Approver Roles** in TS Item Code Settings to the small group who should hold the
>    decision, e.g. just `Item Manager`.
> 3. Test with a non-approver login: the button should read *Submit for Approval*, and the
>    resulting record should sit at `Pending Approval` with no Item behind it.
>
> Email notifications additionally need a working outgoing **Email Account** on the site. The
> in-app bell notification works without one. Notification failures are swallowed on purpose —
> they can never break an approval.

---

## 6. Fixed Assets

Fixed Asset items use their own format and their own counter, keyed on the fiscal year:

```
FA-{company character code}-{FY short}-{5-digit serial}     →   FA-TM-25-26-00001
```

The fiscal year short form is derived from the Fiscal Year name (`2025-2026` → `25-26`), and the
counter resets naturally each fiscal year. Fixed Asset codes always use the **character** company
code and **5** serial digits, regardless of the toggles and the Serial Digits setting.

**Two things must exist on the site first:**

1. An **Item Group named exactly `Fixed Assets`** — asset items are filed under it. Create it if
   your site does not have it.
2. **At least one Asset Category**, and you must select one on the form. It is required so ERPNext
   can auto-create the Asset record when the Purchase Order is received.

If either is missing you get a clear error rather than a broken item. The created Item is
`is_fixed_asset = 1`, `is_stock_item = 0`, `auto_create_assets = 1`. Make sure the chosen Asset
Category has its fixed-asset and depreciation accounts filled in for the company — that is
ERPNext's own validation and it will block the Item insert if incomplete.

---

## 7. Doctypes installed

| DocType | Type | What it is for |
|---|---|---|
| **TS Item Creator** | Document | One record per item-creation request: the inputs, the generated code, the resulting Item link, and the approval trail (status, requested by, approved by/on, rejection reason). Auto-named from its own series — this is the request number, not the item code. |
| **TS Item Creator Variant** | Child table | Rows of TS Item Creator — one per variant to create, with its own brand/variant, rates and opening stock. |
| **TS Item Code Settings** | Single | Separator, serial digits, approver roles, and the auto-managed serial counters. |
| **TS Code Counter** | Child table | Rows of TS Item Code Settings — the last serial issued per company code + category code. |
| **TS Variant** | Master | Your own variant codes (code, name, enabled) for when the variant dimension is not an ERPNext Brand — e.g. grade, size, packing. |

Plus one desk page, `item-creator`, and one Item Attribute (`TS Variant Code`) created on demand
the first time you create a variant item.

> The `TS` prefix and these exact names are load-bearing — raw SQL, the settings parent string and
> the Item Attribute name all depend on them. Do not rename them.

---

## 8. Uninstall

```bash
bench --site <site> uninstall-app item_creator
```

This removes the 5 doctypes, their data and the Item Creator page.

**What stays behind, by design:**

- The 5 **Custom Fields** on Company / Item Group / Brand, and the codes you entered in them.
  Remove them manually from the **Custom Field** list if you really want them gone.
- Every **Item** and **Stock Entry** the app created. They are ordinary ERPNext records and keep
  working normally — the codes just stop being generated for you.
- The **`TS Variant Code`** Item Attribute and its values, because created variant items still
  reference it. Deleting it would break those items.

---

## 9. Known limitations and caveats

- **Do not install this on a site that already has the `trustbit_ethanol` app.** That app ships
  doctypes with the same names (`TS Item Creator`, `TS Item Code Settings`, `TS Code Counter`,
  `TS Variant`, `TS Item Creator Variant`). They will collide, and whichever app migrates last
  wins the schema. Pick one or the other per site.
- **It governs new items only.** Existing items are not renamed, re-coded or validated against the
  format. After install you will have a mixed master until the old items age out, and that is
  expected. There is no migration or bulk re-coding tool.
- **Duplicate search degrades on very large item masters.** When the fast token search returns
  fewer than five hits, the fuzzy fallback loads all non-disabled item names into memory and
  scores them. That is comfortable at a few thousand items, and noticeably slower at tens of
  thousands. It runs debounced and per keystroke-pause, and it fails silently to an empty list
  rather than blocking the form.
- **Codes are permanent.** There is no rename cascade. Change a Company Code or Category Code and
  new items get the new prefix while old items keep the old one.
- **Counters are per company + category and keyed on the character codes.** Set the ABC codes even
  in numeric mode (see section 3a), or the preview will show `001` and the counter key will shift
  under you when you fill them in later.
- **One item, or one template plus its variants, per submission.** There is no CSV/bulk import
  path in this app.
- **HSN/SAC is a link to the `GST HSN Code` doctype**, which is provided by India Compliance. On a
  site without it, leave the field blank — the value is only written to the Item when set.
- **Page access is by role.** If someone cannot see `/app/item-creator`, give them one of the
  standard roles the page is granted to (System Manager, Item Manager, Stock Manager, Stock User,
  Purchase Manager/User, Accounts Manager/User, Sales User, Manufacturing User, Maintenance User,
  Projects User, Auditor).

---

## 10. Development

Work on a local clone and install it from the path:

```bash
cd ~/frappe-bench

# install from a local checkout instead of GitHub
bench get-app /absolute/path/to/item_creator

bench --site dev.localhost install-app item_creator
bench --site dev.localhost set-config developer_mode 1
bench --site dev.localhost clear-cache
bench start
```

With `developer_mode` on, changes you make to doctypes in the desk UI are written back to the
app's JSON files, so they can be committed.

Common loop while developing:

```bash
# after editing JS/CSS
bench build --app item_creator

# after editing doctype JSON or adding a patch
bench --site dev.localhost migrate

# after editing Python
bench restart          # or just let `bench start` reload

# when things look stale
bench --site dev.localhost clear-cache && bench clear-website-cache
```

Layout:

```
item_creator/
├── item_creator/                       # python package
│   ├── item_creator/                   # the "Item Creator" module
│   │   ├── doctype/
│   │   │   ├── ts_item_creator/        # main document + all server logic
│   │   │   ├── ts_item_creator_variant/
│   │   │   ├── ts_item_code_settings/
│   │   │   ├── ts_code_counter/
│   │   │   └── ts_variant/
│   │   └── page/item_creator/          # the guided desk page (html/js/css)
│   └── public/js/                      # Item list override
└── README.md
```

Whitelisted server methods live in
`item_creator.item_creator.doctype.ts_item_creator.ts_item_creator`.

---

## License

MIT. Published by Trustbit Software.
