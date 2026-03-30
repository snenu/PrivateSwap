/**
 * Decorative layer: CSS-only motion (respects prefers-reduced-motion).
 */
export function AnimatedBackground() {
  return (
    <div className="animated-bg" aria-hidden="true">
      <div className="animated-bg__mesh" />
      <div className="animated-bg__orb animated-bg__orb--a" />
      <div className="animated-bg__orb animated-bg__orb--b" />
      <div className="animated-bg__orb animated-bg__orb--c" />
      <div className="animated-bg__shine" />
    </div>
  )
}
