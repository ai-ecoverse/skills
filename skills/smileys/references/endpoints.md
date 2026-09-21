# Smiley’s shop API (HAR rec-1790006577637-qkwv8m, 2026-09-21)

Base: `https://shop.smileys.de/api/v1`
Auth: first-party cookies on `shop.smileys.de` / `mein.smileys.de` (HAR `cookies: []` — httpOnly). Page-context fetch only.
Header seen on stores + session: `X-Widget-Version: 4.1.0`
CORS `Access-Control-Allow-Origin: *`. Rate limit `x-ratelimit-limit: 120`.
Store slug in this capture: **potsdam**.

| Method | Path | Notes |
|---|---|---|
| GET | `/stores` | Full catalog (~82 KB JSON). `cf-cache-status: HIT`, max-age 30s. |
| GET | `/service/autocomplete?query=` | Address as typed (Potsdam Rudolf…). |
| POST | `/service/session` | Body text/plain JSON `{"address","number"}`. From `mein.smileys.de`. |
| GET | `/store/{store}/products/{sp_id}/groups` | Size/topping groups for a product. |
| POST | `/store/{store}/cart/items` | Add line. Body JSON below. Returns `{status, message, data.cart}`. |
| GET | `/enterprise/smileys/v1/cart-suggestions` | Upsell ids. |
| GET | `/store/{store}/categories/{sc_id}/status` | Available product ids in a category. |
| POST | `/store/{store}/checkout` | Start checkout `{customer:{}, shipping_time, message}`. |
| PUT | `/store/{store}/checkout` | Customer + address. |
| GET | `/store/{store}/checkout/deliveryOptions` | After checkout time step. |
| POST | `/store/{store}/checkout/payment/wallet` | Stripe PaymentIntent (`creditcard (wallet)`). **Charges.** |
| POST | `/store/{store}/checkout/payment/paypal` | Body `{}`. Tab closed; response body not captured. **Charges.** |

No GET `/cart` in the recording — cart state is the POST `/cart/items` response (`data.cart`).

## POST /cart/items

```json
{
  "item": "sp_eusIzlcHSil9",
  "options": [
    {"group": "cpg_…", "item": "sp_…", "amount": 1}
  ],
  "quantity": 1,
  "size": "large"
}
```

Captured add: Pizza Buffalo LARGE `sp_eusIzlcHSil9`, path `pizza-buffalo`, 15.49 + 1.49 delivery, cart id `e0fbcc09-da36-42d3-b2fd-bc7301fe4c5b`, `method: delivery`.

## PUT /checkout

`customer.type=private` plus name, email, telephone_raw, street, number, zipcode, city. Do not hardcode; pass flags.

## Flow in this recording

`www.smileys.de/bestellen/…/potsdam` → `mein.smileys.de/anmelden` → `shop.smileys.de/store/potsdam/category/{specials,pizza}` → cart adds → checkout → PayPal (`www.paypal.com/checkoutnow`) — tab closed there.
