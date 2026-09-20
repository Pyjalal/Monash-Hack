export function Mark() {
  return (
    <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
      <path
        d="M16 2 28 9v14l-12 7L4 23V9Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M11 9h10v13H11zM8 12v13h10M14 13h4m-4 4h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
export function DocumentArt({ large = false }: { large?: boolean }) {
  return (
    <svg
      className={large ? "document-art large" : "document-art"}
      viewBox="0 0 360 170"
      fill="none"
      role="img"
      aria-label="Shipping instruction and bill of lading connected by an evidence lens"
    >
      <path d="M32 26h74l20 20v104H32Z" fill="#fcfdff" stroke="#97abc9" />
      <path d="M106 26v20h20" fill="#e4ecfb" stroke="#97abc9" />
      <path d="M234 26h74l20 20v104h-94Z" fill="#fcfdff" stroke="#97abc9" />
      <path d="M308 26v20h20" fill="#e4ecfb" stroke="#97abc9" />
      <text
        x="48"
        y="60"
        fill="#142641"
        fontSize="17"
        fontFamily="Segoe UI, sans-serif"
        fontWeight="650"
      >
        SI
      </text>
      <text
        x="250"
        y="60"
        fill="#142641"
        fontSize="17"
        fontFamily="Segoe UI, sans-serif"
        fontWeight="650"
      >
        BL
      </text>
      <path
        d="M49 77h59M49 91h47M49 105h56M49 119h35M251 77h59M251 91h47M251 105h56M251 119h35"
        stroke="#9bacc4"
        strokeLinecap="round"
      />
      <path d="M126 86h29m50 0h29" stroke="#2355ce" strokeDasharray="3 4" />
      <circle cx="180" cy="85" r="28" fill="#edf2ff" stroke="#2355ce" />
      <circle cx="179" cy="83" r="11" stroke="#2355ce" strokeWidth="2" />
      <path
        d="m187 91 15 15m-28-23 4 4 7-8"
        stroke="#2355ce"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M46 158h66m136 0h66" stroke="#dce5f2" strokeLinecap="round" />
    </svg>
  );
}
