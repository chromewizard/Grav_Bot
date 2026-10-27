// Original Grav Bot vector avatars. No third-party avatar runtime or artwork.
export const mapShapeToBody = shape => String(shape || 'blob');
export const makeAppearance = color => ({ color: /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#8d9eff' });
export function createActor({ body = 'blob' } = {}) {
  return { advance() {}, frame: () => ({ body }) };
}

export function renderSvgString(frame, appearance, size = 36) {
  const body = frame.body || 'blob';
  const angular = ['hex', 'gem', 'crystal', 'shield', 'wedge', 'star', 'sparkle'].includes(body);
  const tall = ['capsule', 'cylinder', 'tablet', 'egg', 'teardrop'].includes(body);
  const shape = angular
    ? '<path d="M32 8 53 20 53 44 32 56 11 44 11 20Z"/>'
    : `<rect x="10" y="${tall ? 9 : 14}" width="44" height="${tall ? 46 : 38}" rx="${['square', 'squircle', 'house'].includes(body) ? 10 : 19}"/>`;
  const px = Math.max(12, Math.min(512, Number(size) || 36));
  const color = makeAppearance(appearance.color).color;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 64 64" aria-hidden="true"><g fill="${color}"><path d="M30 5h4v10h-4z"/><circle cx="32" cy="5" r="3"/>${shape}</g><rect x="17" y="24" width="30" height="19" rx="7" fill="#151b31"/><g fill="${color}"><circle cx="25" cy="33" r="3"/><circle cx="39" cy="33" r="3"/></g><path d="M27 47h10" stroke="#151b31" stroke-width="2" stroke-linecap="round"/></svg>`;
}

export function resolveAvatar({ agentId = '', avatarShape, avatarColor } = {}) {
  let hash = 0;
  for (const letter of agentId) hash = (hash * 31 + letter.charCodeAt(0)) >>> 0;
  return { shape: avatarShape || ['blob', 'hex', 'capsule'][hash % 3], color: avatarColor || ['blue', 'cyan', 'violet'][hash % 3] };
}

export function createAvatarController({ body, appearance, size = 36, state = 'idle' }) {
  return {
    attach({ host }) {
      host.innerHTML = renderSvgString({ body }, appearance, size);
      const svg = host.querySelector('svg');
      const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      const animation = !reduced && svg?.animate ? svg.animate(
        [{ transform: 'translateY(0)' }, { transform: `translateY(${state === 'thinking' ? -2 : -1}px)` }, { transform: 'translateY(0)' }],
        { duration: state === 'thinking' ? 900 : 3600, iterations: Infinity, easing: 'ease-in-out' }
      ) : null;
      return () => { animation?.cancel(); host.replaceChildren(); };
    }
  };
}
