# Northwind Goods (demonstration app A)

A small online store. Customers sign in, add products to a cart, pay at
checkout and see their orders on the account overview.

## Behaviour

- Prices are in dollars. A cart's subtotal is the sum of price × quantity.
- Payment is simulated. An order is `paid` once its payment succeeds; a
  declined payment leaves the order `payment_failed` and the cart unchanged.
- The payment provider reports results to `POST /api/webhooks/payment` with
  `{ eventId, orderId, type }`. Each event id is processed at most once.
- `GET /api/account` returns the signed-in customer, their orders and their
  loyalty transactions as JSON.

## Running

`TEST_MODE=1 GIT_SHA=<commit> npm start` after `npm run build`. Test fixtures
under `/api/test/` exist only in test mode.
