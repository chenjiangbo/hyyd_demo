import './PetAvatar.css'

export type PetVisualState =
  | 'idle'
  | 'dragover'
  | 'receiving'
  | 'working'
  | 'speaking'
  | 'done'
  | 'unknown'
  | 'candidates'

interface Pixel {
  x: number
  y: number
  size: number
  color: string
  delay: string
}

interface PetAvatarProps {
  state: PetVisualState
  reducedMotion?: boolean
}

const bodyPixels: Pixel[] = [
  { x: 28, y: 48, size: 18, color: '#ef2e29', delay: '0s' },
  { x: 46, y: 43, size: 18, color: '#ff7040', delay: '-.2s' },
  { x: 64, y: 42, size: 18, color: '#ff9d36', delay: '-.4s' },
  { x: 82, y: 42, size: 18, color: '#ffb536', delay: '-.6s' },
  { x: 100, y: 48, size: 18, color: '#ee2e2b', delay: '-.8s' },
  { x: 16, y: 66, size: 18, color: '#f02d2d', delay: '-.15s' },
  { x: 34, y: 66, size: 18, color: '#ff9630', delay: '-.35s' },
  { x: 52, y: 64, size: 18, color: '#ffaf36', delay: '-.55s' },
  { x: 70, y: 64, size: 18, color: '#ffc24b', delay: '-.75s' },
  { x: 88, y: 65, size: 18, color: '#ff9d36', delay: '-.95s' },
  { x: 106, y: 66, size: 18, color: '#f02f2b', delay: '-1.15s' },
  { x: 18, y: 84, size: 18, color: '#ef2e29', delay: '-.3s' },
  { x: 34, y: 84, size: 18, color: '#ff8b32', delay: '-.5s' },
  { x: 104, y: 84, size: 18, color: '#ff6937', delay: '-.7s' },
  { x: 24, y: 102, size: 18, color: '#f02c2b', delay: '-.45s' },
  { x: 42, y: 104, size: 18, color: '#ff7138', delay: '-.65s' },
  { x: 60, y: 105, size: 18, color: '#f02d2b', delay: '-.85s' },
  { x: 78, y: 104, size: 18, color: '#ff9e35', delay: '-1.05s' },
  { x: 96, y: 102, size: 18, color: '#ef302c', delay: '-1.25s' },
  { x: 42, y: 122, size: 17, color: '#f02e2b', delay: '-.55s' },
  { x: 60, y: 123, size: 17, color: '#f32e2b', delay: '-.75s' },
  { x: 78, y: 122, size: 17, color: '#ffae37', delay: '-.95s' }
]

const floatingPixels: Pixel[] = [
  { x: 10, y: 33, size: 12, color: '#ff9d36', delay: '-.1s' },
  { x: 27, y: 18, size: 13, color: '#f3312c', delay: '-.6s' },
  { x: 49, y: 5, size: 14, color: '#ff4c31', delay: '-1s' },
  { x: 91, y: 11, size: 13, color: '#ed302c', delay: '-1.4s' },
  { x: 124, y: 36, size: 12, color: '#ff9c31', delay: '-1.8s' },
  { x: 5, y: 87, size: 12, color: '#ff9b35', delay: '-2.2s' },
  { x: 9, y: 112, size: 13, color: '#ffad39', delay: '-.3s' },
  { x: 112, y: 118, size: 13, color: '#f02e2b', delay: '-.9s' },
  { x: 130, y: 92, size: 11, color: '#ff9b35', delay: '-1.5s' },
  { x: 47, y: 142, size: 12, color: '#f55231', delay: '-2s' },
  { x: 73, y: 145, size: 11, color: '#ff9d36', delay: '-2.4s' }
]

function PixelRect({ pixel, className }: { pixel: Pixel; className: string }): React.JSX.Element {
  const tone = pixel.color.startsWith('#ef') || pixel.color.startsWith('#ee') || pixel.color.startsWith('#f0') || pixel.color.startsWith('#f2') || pixel.color.startsWith('#f3')
    ? 'red'
    : pixel.color.startsWith('#ffc')
      ? 'yellow'
      : 'orange'
  return (
    <rect
      className={className}
      x={pixel.x}
      y={pixel.y}
      width={pixel.size}
      height={pixel.size}
      rx="3"
      fill={`url(#pet-pixel-${tone})`}
      stroke="rgba(151, 37, 28, .18)"
      strokeWidth="1"
      style={{ '--pixel-delay': pixel.delay } as React.CSSProperties}
    />
  )
}

export function PetAvatar({ state, reducedMotion = false }: PetAvatarProps): React.JSX.Element {
  return (
    <svg
      className={`pet-avatar pet-avatar--${state} ${reducedMotion ? 'pet-avatar--reduced-motion' : ''}`}
      viewBox="0 0 148 160"
      role="img"
      aria-label="寰宇医道像素精灵"
    >
      <defs>
        <linearGradient id="pet-pixel-red" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff6150" />
          <stop offset=".48" stopColor="#f02e29" />
          <stop offset="1" stopColor="#bd1f25" />
        </linearGradient>
        <linearGradient id="pet-pixel-orange" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffc05b" />
          <stop offset=".5" stopColor="#ff8a32" />
          <stop offset="1" stopColor="#df5427" />
        </linearGradient>
        <linearGradient id="pet-pixel-yellow" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffe47a" />
          <stop offset=".55" stopColor="#ffc24b" />
          <stop offset="1" stopColor="#ec8c2c" />
        </linearGradient>
        <linearGradient id="pet-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" />
          <stop offset=".72" stopColor="#fffaf2" />
          <stop offset="1" stopColor="#f0d8c8" />
        </linearGradient>
        <linearGradient id="pet-cross" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff4d3e" />
          <stop offset="1" stopColor="#bd2025" />
        </linearGradient>
        <filter id="pet-pixel-shadow" x="-30%" y="-30%" width="170%" height="180%">
          <feDropShadow dx="1.5" dy="2.5" stdDeviation="1.2" floodColor="#8e281f" floodOpacity=".3" />
        </filter>
        <filter id="pet-face-shadow" x="-20%" y="-20%" width="150%" height="170%">
          <feDropShadow dx="1.5" dy="3" stdDeviation="1.5" floodColor="#9e3d2e" floodOpacity=".3" />
        </filter>
      </defs>
      <g data-layer="effect-ring" className="pet-avatar__effect-ring">
        <ellipse cx="74" cy="142" rx="39" ry="5" />
        <ellipse className="pet-avatar__energy-ring" cx="74" cy="101" rx="58" ry="25" />
      </g>
      <g data-layer="body-pixels" className="pet-avatar__body-pixels">
        {bodyPixels.map((pixel) => <PixelRect key={`${pixel.x}-${pixel.y}`} pixel={pixel} className="pet-avatar__pixel" />)}
      </g>
      <g data-layer="floating-pixels" className="pet-avatar__floating-pixels">
        {floatingPixels.map((pixel) => <PixelRect key={`${pixel.x}-${pixel.y}`} pixel={pixel} className="pet-avatar__floating-pixel" />)}
      </g>
      <g data-layer="medical-cross" className="pet-avatar__medical-cross">
        <rect x="103" y="29" width="30" height="30" rx="6" fill="url(#pet-cross)" filter="url(#pet-pixel-shadow)" />
        <path d="M113 34h10v8h8v10h-8v8h-10v-8h-8V42h8z" fill="#ffdc2f" />
      </g>
      <g data-layer="face-panel" className="pet-avatar__face-panel">
        <rect x="25" y="57" width="99" height="60" rx="15" fill="#c9322b" opacity=".65" transform="translate(1.5 3)" />
        <rect x="25" y="57" width="99" height="60" rx="15" fill="url(#pet-face)" stroke="#ed4030" strokeWidth="2" filter="url(#pet-face-shadow)" />
        <path d="M38 60h72" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity=".78" />
      </g>
      <g data-layer="eyes" className="pet-avatar__eyes">
        <rect x="55" y="76" width="10" height="23" rx="5" fill="#54261e" />
        <rect x="84" y="76" width="10" height="23" rx="5" fill="#54261e" />
        <rect x="58" y="79" width="2" height="6" rx="1" fill="#fff" />
        <rect x="87" y="79" width="2" height="6" rx="1" fill="#fff" />
      </g>
      <g data-layer="face-details" className="pet-avatar__face-details">
        <rect x="36" y="101" width="13" height="5" rx="2.5" fill="#ff9b5d" />
        <rect x="98" y="101" width="13" height="5" rx="2.5" fill="#ff9b5d" />
      </g>
      <g data-layer="mouth" className="pet-avatar__mouth">
        <path d="M70 104q4 6 8 0" fill="none" stroke="#6f2b23" strokeWidth="2.5" strokeLinecap="round" />
      </g>
      <g data-layer="receiving-file" className="pet-avatar__receiving-file">
        <rect x="8" y="61" width="23" height="29" rx="3" fill="#fffaf2" stroke="#e45736" strokeWidth="2" />
        <path d="M13 70h13M13 76h13M13 82h9" stroke="#e45736" strokeWidth="1.8" strokeLinecap="round" />
      </g>
    </svg>
  )
}
