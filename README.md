# Money HQ

Money HQ is a household bookkeeping / checkbook web app built for one job: make the real financial picture visible.

## What is included

- Checkbook / transaction register
- Checking, savings and cash accounts with running balances
- Transfers that do **not** count as spending
- Bill tracker with due day, overdue status, autopay flag, and monthly paid/unpaid status
- Optional automatic checkbook entry when a bill is marked paid
- Debt center: balance, APR, minimum payment, credit limit/utilization, estimated monthly interest
- Debt payment workflow that updates the balance and can create a checkbook entry
- Recurring income schedule and "mark received" workflow
- Dashboard:
  - Cash available
  - Bills before next payday
  - Protected cash reserve
  - **Safe to spend**
  - Total debt
  - Current-month income / spending / net
- Account reconciliation
- Monthly category and merchant spending reports
- CSV export of all checkbook transactions
- Full JSON backup
- Responsive phone / desktop layout

## Why Firebase

The app uses Firebase Authentication + Cloud Firestore. This avoids Google Apps Script and gives the site real-time syncing across devices.

Firebase's web configuration object is **not** a secret. The protection comes from Firebase Authentication and Firestore Security Rules. Never put a Firebase Admin/service-account private key in frontend files.

## First: test the app without Firebase

The supplied `firebase-config.js` contains placeholders. With placeholders present, Money HQ automatically runs in **local test mode**.

Local mode is for trying the interface only. Data stays in that browser and does not sync.

Because `app.js` is a JavaScript module, use a normal web host such as GitHub Pages rather than double-clicking `index.html` from your Downloads folder.

## Firebase setup

1. Go to the Firebase Console and create a project. A name like `money-hq` is fine.
2. On the project overview, add a **Web app**.
3. Firebase gives you a `firebaseConfig` object.
4. Open `firebase-config.js` and replace the placeholder values with your real values.
5. In Firebase Console, open **Build → Authentication → Sign-in method**.
6. Enable **Email/Password**.
7. Open **Build → Firestore Database** and create the database.
8. Open the Firestore **Rules** tab.
9. Replace the rules with the contents of `firestore.rules`, then publish them.
10. Upload these files to the website host:
    - `index.html`
    - `styles.css`
    - `app.js`
    - `firebase-config.js`

### IMPORTANT: do not leave Firestore in open/test rules

The supplied rules only allow a signed-in user to read/write data inside their own:

`/users/{their Firebase UID}/...`

That is what keeps the household financial records private.

## Household login in version 1

Version 1 intentionally uses **one shared household Firebase login**.

Create the household account from the Money HQ sign-in screen, then use the same login on the household devices. All devices see the same Firestore data.

This is much safer and simpler than implementing a half-secure invitation system in the first version. A later version can add separate household-member accounts with invitations and roles.

## Best order for entering your real information

Do not try to fill out everything in one sitting.

### 1. Accounts
Add each checking account, savings account, or cash account. Use the **real balance shown by the bank today** as the starting balance.

### 2. Bills
Add every recurring obligation:
- housing
- utilities
- insurance
- phone
- subscriptions
- minimum payments that you prefer to track as bills
- anything else that reliably comes due

Mark autopay bills as autopay, but still mark them paid only when they actually clear.

### 3. Debts
Add each card/loan separately with current balance, APR, minimum payment, and due day.

### 4. Income schedules
Add expected paychecks. This lets the dashboard calculate "Bills before payday."

### 5. Set protected cash
Settings → Protected cash. This is your "do not touch" cushion.

### 6. Start the checkbook
From this point forward, record transactions. Once or twice per week, use **Reconcile** on each account to compare Money HQ with the bank.

## Safe to spend formula

`Safe to spend = cash in tracked accounts - unpaid bills due through next payday - protected cash`

It is deliberately conservative.

## Bill accounting note

When you mark a bill paid, Money HQ can also create the matching negative checkbook transaction. If you already entered that payment manually, choose **No** when it asks whether to record it in the checkbook, or you will double-count it.

## Debt accounting note

A debt payment reduces the stored debt balance. If you choose to record it in the checkbook, it also creates a cash outflow categorized as `Debt Payment`.

Interest charges and new credit-card purchases are **not automatically added** to debt balances in this version. Reconcile debt balances periodically against the creditor's statement.

## Backups

Use Reports → **Download full backup** periodically. That creates a JSON snapshot.

Use Reports → **Export transactions CSV** if you want to open the checkbook in Google Sheets or Excel.

## Hosting

This code works well on GitHub Pages because it is a static frontend. Firebase handles authentication and the database.

If your GitHub Pages URL is not accepted by Firebase Authentication, add the domain under:

Firebase Console → Authentication → Settings → Authorized domains

## Next build phase

Recommended next features after the household has 2–4 weeks of clean data:

- true separate household-member logins and invitations
- statement closing dates for credit cards
- automatic debt-payoff avalanche/snowball projections
- sinking funds
- budget targets based on actual spending history
- recurring bill generation beyond monthly bills
- automatic transaction import from financial institutions (only after the manual accounting model is stable)
- Google Sheets scheduled export / backup
- monthly close checklist and audit log


## Importing Rose's 2026 Ledger

A private import file was created separately from the website package:

`Money-HQ-2026-Ledger-Import.json`

**Do not upload that JSON file to GitHub.** It contains household financial data.

After Firebase is connected and you are signed into Money HQ:

1. Open **Settings**.
2. Under **Private Import**, choose `Money-HQ-2026-Ledger-Import.json`.
3. Click **Import ledger into Money HQ**.
4. The importer writes the records into your authenticated Firestore user path.
5. Open **Bills** and **Debt Center** and finish the fields marked as needing review.

The imported history intentionally preserves the spreadsheet's month-level timing. Since the source ledger does not contain exact transaction dates, imported records display as `Jan 2026`, `Feb 2026`, etc. rather than pretending every transaction happened on the first day of the month.

### What the import understands

- checking/cash spending
- savings and retirement movements
- credit-card purchases
- credit-card payments as transfers (not new spending)
- cash-side credit-card payments as transfers (avoids double counting)
- refunds/reimbursements separately from income
- current credit-card balances
- non-card debts from the workbook's debt snapshot
- historical paid months for recurring bill candidates where the ledger shows a matching payment

### Fields the ledger does not contain

The importer **does not invent**:
- debt APRs
- debt minimum payments
- debt due days
- recurring bill due days
- autopay status

Those show as setup/review items in Money HQ until you enter them.

### Safe-to-Spend classification

The import currently includes these checking accounts in Safe to Spend:
- OZK Bills
- Aiden OZK
- US Bank
- NFCU Bills

Wealthfront and TSP are tracked but protected from Safe to Spend. Credit cards are tracked as liabilities and are also excluded.
