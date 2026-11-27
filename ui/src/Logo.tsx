interface LogoMarkProps {
  size?: number;
  title?: string;
}

/**
 * MacacoLive mark. Geometry mirrors scripts/make-icon.ps1 so the
 * in-app logo and the Windows .ico are the same drawing.
 */
export function LogoMark({ size = 32, title }: LogoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ flexShrink: 0, display: 'block' }}
    >
      <rect width="64" height="64" rx="15" fill="#F5C842" />
      <circle cx="16" cy="30" r="8" fill="#6B4423" />
      <circle cx="48" cy="30" r="8" fill="#6B4423" />
      <circle cx="16" cy="30" r="4" fill="#EBCB9E" />
      <circle cx="48" cy="30" r="4" fill="#EBCB9E" />
      <circle cx="32" cy="33.5" r="17.5" fill="#6B4423" />
      <circle cx="26.5" cy="31" r="6.5" fill="#EBCB9E" />
      <circle cx="37.5" cy="31" r="6.5" fill="#EBCB9E" />
      <ellipse cx="32" cy="39.5" rx="11" ry="8" fill="#EBCB9E" />
      <circle cx="27" cy="31" r="2" fill="#1F150B" />
      <circle cx="37" cy="31" r="2" fill="#1F150B" />
      <circle cx="30.4" cy="37.6" r="0.9" fill="#1F150B" />
      <circle cx="33.6" cy="37.6" r="0.9" fill="#1F150B" />
      <path
        d="M28 42 C30 44.6 34 44.6 36 42"
        fill="none"
        stroke="#1F150B"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Wordmark({ size = 32 }: { size?: number }) {
  return (
    <div className="wordmark">
      <LogoMark size={size} />
      <span className="wordmark-text">MacacoLive</span>
    </div>
  );
}
