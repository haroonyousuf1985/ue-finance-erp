# Guide 1 - Test on StackBlitz (no installation, about 10 minutes)

## Route A (easiest): upload from GitHub
1. Create a free account at github.com and click **New repository**. Name it `ue-finance-erp`, leave it empty, Create.
2. On the new repository page click **uploading an existing file**.
3. Unzip `ue-finance-erp.zip` on your computer. Open the folder, select EVERYTHING inside it
   (including the folders `server`, `client`, `legacy-src`, `scripts`, `data`) and drag it all into the GitHub page.
   Click **Commit changes**.
   (If GitHub refuses folders by drag, upload with the "Add file > Upload files" button the same way.)
4. In a new browser tab open:  `https://stackblitz.com/github/YOUR-GITHUB-NAME/ue-finance-erp`
   (replace YOUR-GITHUB-NAME with your GitHub username).
5. StackBlitz installs and starts by itself (1-2 minutes). A preview appears on the right.
   If asked, click **Open in New Tab** - the app works best in its own tab.
6. Log in with **admin / admin123**. When it asks you to change the password, do so (minimum 8 characters).

## Route B: drag the folder into StackBlitz directly
1. Go to stackblitz.com > **Create** > choose the **Node.js** starter.
2. Delete its sample files, then drag all files and folders from the unzipped folder into the file list on the left.
3. In the terminal at the bottom type `npm install` and press Enter, then `npm start`.

## What to test (suggested order)
1. Admin tab: add a campus + budget code + allocation (e.g. Main Campus, B-101, 1,000,000).
2. Admin > Add User: make one user per role (Accounts, RA, IBFT, DiaryClerk).
3. Admin > Employees, Bank Accounts, Receiving Offices: add one each.
4. Log in as the Diary clerk: log a bill, assign it. As Accounts: Diary > Enter This Bill > Save.
5. Processing > Passing > Payment/IBFT (CSV downloads) > Confirmation > Reports.
6. Try a Section 149 employee bill and check the tax figures against your Google Sheets version.

## Good to know on StackBlitz
- Data lives inside the StackBlitz session; it can reset when the project restarts. That is normal for testing.
- PDF buttons need internet access to cdnjs.cloudflare.com (same as your old version).
- If the preview looks stuck, click the refresh icon above the preview, or open it in a new tab.
