export interface ReadabilityFacts {
  nonWhitespaceCharacters: number;
  lettersOrNumbers: number;
  replacementCharacters: number;
  controlCharacters: number;
  suspiciousRatio: number;
}

function isSuspiciousControl(character: string): boolean {
  const code = character.codePointAt(0)!;
  return (code < 32 && ![9, 10, 12, 13].includes(code)) || (code >= 127 && code <= 159);
}

export function hasDamagedCharacters(text: string): boolean {
  return [...text].some(character => character === "\ufffd" || isSuspiciousControl(character));
}

export function assessReadability(text: string): { status: "READABLE" | "EMPTY" | "GARBLED"; facts: ReadabilityFacts } {
  const characters = [...text];
  const nonWhitespaceCharacters = characters.filter(character => !/\s/u.test(character)).length;
  const replacementCharacters = characters.filter(character => character === "\ufffd").length;
  const controlCharacters = characters.filter(isSuspiciousControl).length;
  const lettersOrNumbers = characters.filter(character => /[\p{L}\p{N}]/u.test(character)).length;
  const denominator = Math.max(nonWhitespaceCharacters, controlCharacters, 1);
  const suspiciousRatio = (replacementCharacters + controlCharacters) / denominator;
  const status = nonWhitespaceCharacters === 0 && controlCharacters === 0 ? "EMPTY" : suspiciousRatio >= 0.1 || controlCharacters / denominator >= 0.05 ? "GARBLED" : "READABLE";
  return { status, facts: { nonWhitespaceCharacters, lettersOrNumbers, replacementCharacters, controlCharacters, suspiciousRatio } };
}
