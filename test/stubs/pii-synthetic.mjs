/** Run-time builders for synthetic, checksum-valid test values (no real person or account). */

export function makeTckn(seed = 123456789) {
  const d = String(seed).padStart(9, '1').slice(0, 9).split('').map(Number);
  if (d[0] === 0) d[0] = 1;
  const odd = d[0] + d[2] + d[4] + d[6] + d[8];
  const even = d[1] + d[3] + d[5] + d[7];
  const d10 = (((odd * 7 - even) % 10) + 10) % 10;
  const d11 = (odd + even + d10) % 10;
  return [...d, d10, d11].join('');
}
export function makeLuhn(prefix = '453201511283036') {
  let sum = 0;
  for (let i = prefix.length - 1, dbl = true; i >= 0; i--, dbl = !dbl) {
    let n = Number(prefix[i]);
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return prefix + ((10 - (sum % 10)) % 10);
}
export function makeTrIban(account = '0000001234567890') {
  const bban = '00061' + '0' + account.padStart(16, '0');
  const digits = (bban + 'TR00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return 'TR' + String(98 - rem).padStart(2, '0') + bban;
}
export const spaced = (iban) => iban.replace(/(.{4})/g, '$1 ').trim();
export const makeEmail = () => 'jane.doe' + '@' + 'example.org';
export const bump = (num) => num.slice(0, -1) + String((Number(num.slice(-1)) + 1) % 10);

