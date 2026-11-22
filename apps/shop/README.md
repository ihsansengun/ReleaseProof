# Northwind Goods (demonstration app A)

A small online store. Customers sign in, add products to a cart, pay at
checkout and see their orders on the account overview.

## Behaviour

- Prices are in dollars. A cart's subtotal is the sum of price × quantity.
- A customer can apply one promo code to their cart. `SAVE10` takes 10% off
  the subtotal; `TAKE15` takes $15.00 off a subtotal of at least $60.00. Codes
  are not case-sensitive. The order total is the subtotal minus the discount,
  and each customer can use a code on one paid order only.
- Payment is simulated. An order is `paid` once its payment succeeds; a
  declined payment leaves the order `payment_failed` and the cart unchanged.
- The payment provider reports results to `POST /api/webhooks/payment` with
  `{ eventId, orderId, type }`. Each event id is processed at most once.
- `GET /api/account` returns the signed-in customer, their orders and their
  loyalty transactions as JSON. Each order carries `totalCents` (the amount
  charged), `discountCents` and `promoCode` (`null` when no code was used).
- `GET /api/cart` returns the signed-in customer's cart as JSON: `lines`,
  `subtotalCents`, `promoCode`, `discountCents` and `totalCents`.

## Running

`TEST_MODE=1 GIT_SHA=<commit> npm start` after `npm run build`. Test fixtures
under `/api/test/` exist only in test mode.
