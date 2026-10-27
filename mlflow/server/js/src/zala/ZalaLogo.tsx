export const ZalaLogo = (props: React.SVGProps<SVGSVGElement>) => {
  return (
    <svg
      width="109"
      height="40"
      viewBox="0 0 109 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      {...props}
    >
      <title>ZALABench</title>
      {/* Z monogram in a rounded tile */}
      <rect x="0" y="7" width="26" height="26" rx="7" fill="var(--zala-logo-bg, #28a745)" />
      <path d="M6.5 13.5H19.5V17L11.6 24H19.5V27H6.5V23.5L14.4 16.5H6.5Z" fill="#ffffff" />
      {/* Wordmark */}
      <text
        x="34"
        y="26.5"
        fill="currentColor"
        fontFamily="'Inter', 'Segoe UI', Arial, sans-serif"
        fontSize="16"
        fontWeight="700"
        letterSpacing="0.4"
      >
        ZALABench
      </text>
    </svg>
  );
};
