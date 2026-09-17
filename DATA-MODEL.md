# Money HQ data model

All Firebase data lives below the signed-in user's UID.

```
users/{uid}/
  accounts/{accountId}
  transactions/{transactionId}
  bills/{billId}
  billPayments/{billId_YYYY-MM}
  debts/{debtId}
  incomeSchedules/{incomeId}
  settings/main
```

## Accounts

- `name`
- `type`: checking | savings | cash | other
- `openingBalance`

Current account balance is calculated as:

`openingBalance + sum(all transaction amounts assigned to the account)`

## Transactions

- `date`: YYYY-MM-DD
- `type`: expense | income | transfer
- `payee`
- `amount`: signed number; expenses negative, income positive
- `accountId`
- `category`
- `note`
- optional: `transferGroup`, `billPaymentId`, `debtId`

Transfers create two entries with the same `transferGroup`: one negative from the source account and one positive into the destination account. Transfer entries are excluded from spending reports.

## Bills

- `name`
- `amount`
- `dueDay`
- `accountId`
- `category`
- `autopay`
- `active`

Bills currently recur monthly.

## Bill payments

Document ID: `{billId}_{YYYY-MM}`

- `billId`
- `month`
- `date`
- `amount`
- `accountId`

This makes paid/unpaid status deterministic for each monthly bill occurrence.

## Debts

- `name`
- `type`
- `balance`
- `apr`
- `minimumPayment`
- `limit`
- `dueDay`

## Income schedules

- `name`
- `amount`
- `frequency`: weekly | biweekly | semimonthly | monthly
- `nextDate`
- `accountId`
- `active`

## Settings

`settings/main`

- `reserveAmount`
