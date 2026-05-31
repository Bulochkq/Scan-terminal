# 📦 Warehouse Scan Terminal (Google Apps Script)

A lightweight, responsive, and robust **Warehouse Inventory Terminal** web application powered by **Google Apps Script (GAS)** and **Google Sheets**. It features real-time scanning capabilities using the device camera, conflict resolution for concurrent workers, audit logs, and an administrator panel to manage workers, worksheets, backups, and imports.

> [!NOTE]
> This repository represents a test/development release version of the terminal. Production-ready variations are maintained separately.

---

## 🚀 Key Features

* **📷 Real-Time Camera Scanner**: Integrates `html5-qrcode` to scan PLU, SKU, and EAN barcodes directly through desktop or mobile browsers.
* **⚡ Keyboard-Only Mode**: Fallback/virtual keyboard interface optimized for physical barcode scanning guns that input data as keyboard events.
* **🔐 Admin Portal**: Protected area (`PIN: 85592` by default) supporting:
  * Creating new warehouse sheets.
  * Uploading inventory databases via `.xlsx` spreadsheets directly.
  * Importing data from a dedicated local staging sheet (`FLEX_IMPORT`).
  * Deleting sheets safely with automated backup mechanisms.
  * Clearing audit logs.
  * Tracking sheet backup history.
* **👥 User/Workplace Selection**: Dynamic loading of workers list and active warehouse sheets.
* **🔄 Optimistic Local Database & Heartbeat**: Syncs state with Google Sheets via a fast background heartbeat script, detecting and resolving concurrent editing conflicts by displaying banner warnings (e.g., *"Warning! [User] is also working here"*).
* **🔊 Audio Feedback System**: Synthesizes and plays specific oscillator tones for positive scans, completed plan achievements, duplicates, and warning events.
* **📈 Real-Time Statistics**: Displays live visual progress bars (target vs. actual inventory), missing list, and surplus items.

---

## 🛠️ Architecture & Tech Stack

The project is structured entirely within the Google Apps Script ecosystem, enabling quick deployment with zero server setup costs.

### Backend (Google Apps Script - `.gs`)
- [Main.gs](file:///c:/Users/buloc/OneDrive/Рабочий%20стол/Scan%20Terminal/Main.gs): Webapp entry point containing web layout generation (`doGet`), template helpers, and Google Sheets UI integration menu.
- [Database.gs](file:///c:/Users/buloc/OneDrive/Рабочий%20стол/Scan%20Terminal/Database.gs): Handles data fetch operations, queue item updates (atomic database transactions with script locks), and activity lock syncs.
- [Admin.gs](file:///c:/Users/buloc/OneDrive/Рабочий%20стол/Scan%20Terminal/Admin.gs): Admin-specific operations like user registration, backup creation, xlsx parser mapping, and sheet clearing.
- [Logger.gs](file:///c:/Users/buloc/OneDrive/Рабочий%20стол/Scan%20Terminal/Logger.gs): Records all scanner actions, manual corrections, edits, and system errors into a structured `Log` sheet.

### Frontend (HTML/CSS/JS)
- [Index.html](file:///c:/Users/buloc/OneDrive/Рабочий%20стол/Scan%20Terminal/Index.html): Semantic layout container, markup structures, popups, and dialog overlays.
- [Scripts.html](file:///c:/Users/buloc/OneDrive/Рабочий%20стол/Scan%20Terminal/Scripts.html): Main JavaScript orchestrator managing UI rendering, local database cache, tone generation, scanner events, and backend communication.
- [Styles.html](file:///c:/Users/buloc/OneDrive/Рабочий%20стол/Scan%20Terminal/Styles.html): Responsively designed CSS containing mobile-first stylesheet grids, custom dialog layouts, and progress animations.

---

## 📦 Database & Spreadsheet Layout

The inventory spreadsheets must adhere to the following schema structure:
* **Column A (1)**: Brand / Značka
* **Column B (2)**: PLU (Product Identifier)
* **Column C (3)**: Product Title / Názov karty
* **Column D (4)**: SKU / Manufacturer Code
* **Column E (5)**: EAN Barcode
* **Column F (6)**: Planned Quantity / Plán
* **Column G (7)**: Real Quantity / Realita (Updated by scanner)
* **Column H (8)**: Difference / Rozdiel (Formula: `=Realita-Plán`)
* **Column I (9)**: Comments / Poznámка

---

## ⚙️ How to Install and Set Up

Follow these steps to deploy your own instance of the terminal:

1. **Create a Google Spreadsheet**:
   - Create a blank Google Sheet.
   - Create a sheet named `NASTAVENIA` (Settings) for user management.
   - Create a sheet named `Log` for audit tracking.

2. **Open the Apps Script Editor**:
   - In your Google Spreadsheet, click on **Extensions** > **Apps Script**.

3. **Copy the Source Files**:
   - Create matching files in your Apps Script project editor matching this repository's layout:
     - `Main.gs`, `Database.gs`, `Admin.gs`, `Logger.gs`
     - `Index.html`, `Scripts.html`, `Styles.html`
   - Paste the code from each respective file.

4. **Update global constants**:
   - In `Main.gs`, configure the `DEPLOYMENT_URL` variable to point to your Web App URL (generated in step 5).
   - In `Admin.gs` / `Main.gs`, customize the default `ADMIN_PIN` if needed.

5. **Deploy the Web App**:
   - In the Apps Script editor, click **Deploy** > **New deployment**.
   - Select **Web app** as the deployment type.
   - Set *Execute as:* **Me (your-email)**.
   - Set *Who has access:* **Anyone** (required for terminal usage from scan devices without needing individual Google logins).
   - Copy the generated Web App URL and paste it into the `DEPLOYMENT_URL` constant.

6. **Initialize the UI Menu**:
   - Refresh your Google Spreadsheet window. A new menu item called `TERMINÁL (Admin)` will appear.
   - Select **Otvoriť terminál** to launch the sidebar tool or **Otvoriť na celú obrazovku** to view/share the mobile-ready standalone terminal link.
