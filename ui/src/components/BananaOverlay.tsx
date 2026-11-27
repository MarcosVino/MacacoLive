import React from 'react';
import { BananaThrowEvent } from '../types';

interface BananaOverlayProps {
  bananas: BananaThrowEvent[];
  latestThrow: BananaThrowEvent | null;
}

function SplatBananaSvg() {
  return (
    <svg
      width="118"
      height="118"
      viewBox="0 0 120 120"
      fill="none"
      aria-hidden="true"
      className="banana-svg"
    >
      {/* Cartoon sticky yellow splash */}
      <path
        d="M60 14C66 26 76 21 85 27C94 33 88 44 103 51C91 58 98 71 87 79C77 86 70 81 61 98C52 82 41 88 31 79C21 70 30 58 17 48C32 42 26 30 37 25C47 20 53 25 60 14Z"
        fill="#f5c842"
        fillOpacity="0.28"
        stroke="#f5c842"
        strokeOpacity="0.55"
        strokeWidth="2"
      />
      {/* Splash droplets */}
      <circle cx="22" cy="24" r="4.5" fill="#ffd45e" fillOpacity="0.82" />
      <circle cx="99" cy="28" r="3.5" fill="#ffd45e" fillOpacity="0.82" />
      <circle cx="96" cy="91" r="4" fill="#f5c842" fillOpacity="0.78" />
      <circle cx="24" cy="94" r="3" fill="#ffd45e" fillOpacity="0.75" />

      {/* Main curved cartoon banana */}
      <path
        d="M32 74C46 89 75 86 89 65C98 51 98 33 87 22C85 20 82 22 83 25C86 38 80 51 69 60C57 69 43 70 33 67C30 66 29 71 32 74Z"
        fill="#f5c842"
        stroke="#4f360c"
        strokeWidth="3.2"
        strokeLinejoin="round"
      />
      {/* Highlight crescent */}
      <path
        d="M44 74C59 77 76 69 84 54"
        stroke="#fff3b8"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {/* Stem tip */}
      <path
        d="M86 22L92 17"
        stroke="#5c3e10"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle cx="31" cy="70" r="3.2" fill="#5c3e10" />

      {/* Comic impact burst lines */}
      <path
        d="M60 6L60 14M108 55L100 55M60 112L60 103M11 55L20 55"
        stroke="#ffe68a"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function BananaIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 17.5C8.5 20.5 15 19.5 18.5 14.5C20.8 11.2 20.8 6.8 18.2 4.2C17.7 3.7 17 4.2 17.2 4.9C17.8 7.8 16.4 10.9 13.8 13C11 15.2 7.6 15.6 5.4 14.8C4.6 14.5 4.2 16.8 5 17.5Z"
        fill="#f5c842"
        stroke="#4f360c"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M18.2 4.2L19.8 2.8" stroke="#855a14" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export const BananaOverlay: React.FC<BananaOverlayProps> = ({ bananas, latestThrow }) => {
  if (bananas.length === 0 && !latestThrow) return null;

  return (
    <div className="banana-layer" aria-hidden="true">
      {bananas.map((b) => {
        const style = {
          left: `${b.targetX}%`,
          top: `${b.targetY}%`,
          '--dx': `${b.startX - b.targetX}vw`,
          '--dy': `${b.startY - b.targetY}vh`,
          '--rot': `${b.rotation}deg`,
        } as React.CSSProperties;

        return (
          <div key={b.id} className="banana-splat" style={style}>
            <SplatBananaSvg />
            <span className="banana-tag">
              {b.nick}
              {b.combo > 1 ? ` x${b.combo}` : ''}
            </span>
          </div>
        );
      })}

      {latestThrow && (
        <div key={latestThrow.id} className="banana-banner">
          <span className="banana-banner-dot" />
          <span>
            <strong>{latestThrow.nick}</strong> tacou uma banana na transmissão!
          </span>
          {latestThrow.combo >= 2 && (
            <span className="banana-combo-badge num">COMBO x{latestThrow.combo}</span>
          )}
        </div>
      )}
    </div>
  );
};
