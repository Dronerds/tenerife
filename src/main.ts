/**
 * Entry point.
 *
 * The three.js renderer that used to live here is gone; the Cesium viewer that
 * replaces it lands in the next commit. What remains is the shell both versions
 * share: the HUD element, and a catch that puts any startup failure on screen
 * rather than only in the console.
 */

const hud = document.getElementById('hud') as HTMLDivElement

async function main(): Promise<void> {
  hud.textContent = 'no renderer yet'
}

main().catch((error: unknown) => {
  hud.textContent = `error: ${error instanceof Error ? error.message : String(error)}`
  console.error(error)
})
