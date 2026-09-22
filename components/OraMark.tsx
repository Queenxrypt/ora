type OraMarkProps = {
  className?: string;
};

export function OraMark({ className }: OraMarkProps) {
  return (
    <svg
      className={className}
      viewBox="94 28 316 146"
      fill="currentColor"
      role="img"
      aria-label="ORA"
    >
      <title>ORA</title>
      <path
        fillRule="evenodd"
        d="M98 124a45 45 0 1 0 90 0a45 45 0 1 0-90 0M120 124a23 23 0 1 1 46 0a23 23 0 1 1-46 0"
      />
      <path d="M197 32h32v136h-32z" />
      <path
        fillRule="evenodd"
        d="M218 32C268 26 314 44 308 74C302 104 264 114 218 104V32zM234 70a24 14 0 1 0 48 0a24 14 0 1 0-48 0"
      />
      <polygon points="222,114 276,100 312,168 266,168" />
      <path
        fillRule="evenodd"
        d="M357 77L302 168h106L357 77zM357 104L346 134h22L357 104zM346 150h32l8 18h-48l8-18z"
      />
    </svg>
  );
}
