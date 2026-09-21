/** Complete-name aliases verified against UNECE country lists (2026-09-21).
 * https://service.unece.org/trade/locode/{in,lt,tr,pe,cl,kr}.htm
 * India also verified against https://www.jnport.gov.in/page/ports-connected-with-jnpa/ZlN1YUJoTCt4cUNKcWJKRWZoVHFJZz09
 * Competition-specific aliases below follow the supplied task ground truth.
 * They are business identifiers, not assertions about the global UN/LOCODE registry.
 * Only complete values match; unknown qualifiers and other port lists remain distinct.
 */
export const PORT_POLICY_VERSION = 'competition-ports-v1';
const PORT_CODES: Readonly<Record<string, string>> = {
  'BUATAN INDONESIA': 'IDBUA',
  'RUGAO NANTONG SHANGHAI CHINA': 'CNSHA',
  'NHAVA SHEVA INDIA': 'INNSA',
  'KLAIPEDA LITHUANIA': 'LTKLJ',
  'MERSIN TURKEY': 'TRMER',
  'MERSIN TURKIYE': 'TRMER',
  'CALLAO PERU': 'PECLL',
  'VALPARAISO CHILE': 'CLVAP',
  'BUSAN SOUTH KOREA': 'KRPUS',
};
export function canonicalPort(value: string): string {
  return PORT_CODES[value] ?? value;
}
