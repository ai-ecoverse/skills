// Shopping-cart line totals, in integer cents.
// Bulk pricing: 3 or more of the same item get 10% off that line.

export const BULK_QTY = 3;
export const BULK_DISCOUNT = 0.1;

export function lineTotal({ unitCents, qty }) {
  if (!Number.isInteger(unitCents) || unitCents < 0) {
    throw new TypeError('unitCents must be a non-negative integer');
  }
  if (!Number.isInteger(qty) || qty < 1) {
    throw new RangeError('qty must be a positive integer');
  }
  const gross = unitCents * qty;
  return qty > BULK_QTY ? Math.round(gross * (1 - BULK_DISCOUNT)) : gross;
}

export function cartTotal(lines) {
  return lines.reduce((sum, line) => sum + lineTotal(line), 0);
}
