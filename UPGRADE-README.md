# Money HQ v3 — Upgrade Instructions

This package is intentionally an **upgrade package**, not a brand-new Firebase setup.

## Replace only these three website files

Upload these files to the root of your existing `MoneyHQ` GitHub repository and replace the files with the same names:

- `index.html`
- `styles.css`
- `app.js`

Do **not** replace or delete your existing `firebase-config.js`. That file already connects the live site to your Firebase project.

Do **not** upload any private ledger/import JSON to GitHub.

Your existing Firestore accounts, bills, transactions, debts, income schedules, paid-bill records, and settings are preserved. This is a frontend/data-model extension, not a reset.

## Firebase rules

The existing Money HQ Firestore rules use `/users/{userId}/{document=**}` and therefore already cover the new collections. No rules change is required.

## New features in v3

- Colorful coral / peach / sage / blue / plum redesign
- Home dashboard with "What can we afford right now?"
- Flexible dollars per day until next scheduled income
- Bill progress / monthly close indicator
- 7 / 14 / 30 day bill outlook
- Full monthly money calendar with bills and recurring income
- Paycheck-survival planner
- Subscription summary
- Debt payoff progress bars
- Snowball and avalanche payoff scenario calculator
- Account asset summary and tracked net worth
- Recurring income moved into Accounts for a cleaner navigation
- Monthly money recap and prior-month comparison
- Spending guardrails by category
- Merchant drill-down / spending history
- Better transaction filters (account, category, type, month, search)
- Goals and sinking-fund tracking
- Money to-do list
- Existing import / backup / CSV tools retained

## New Firestore collections

These are created automatically the first time you use them:

- `goals`
- `moneyTasks`
- `categoryTargets`

No manual Firebase setup is required for those collections.

## A note about "Tracked net worth"

Money HQ only counts assets you actually add as accounts/assets. If your mortgage is in Debt but the house itself is not entered as an asset, tracked net worth will look artificially low. That is intentional rather than inventing a home value. You can add other assets later if you want a fuller net-worth view.

## After uploading

1. Commit the three replacement files in GitHub.
2. Wait for GitHub Pages to deploy.
3. Refresh the live Money HQ site. If the old layout remains, hard-refresh the browser (`Ctrl+Shift+R` on Windows).
4. Sign in normally. Your existing Firebase records should appear automatically.
5. Start with Settings → Protected Cash, then Accounts → recurring income, then Calendar.

