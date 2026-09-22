export function quoteMeetsMinDiscount(
  quoteDiscountPercent: number,
  minDiscountPercent: number,
): boolean {
  return quoteDiscountPercent + 1e-6 >= minDiscountPercent;
}
