import { app } from 'electron'

export function registerAppShutdown(cleanup: () => Promise<void>): void {
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true

    // Keep the deadline until Electron actually quits, even if cleanup finishes
    // but the subsequent quit request does not close the application.
    const timeout = setTimeout(() => app.exit(), 5000)
    app.once('quit', () => clearTimeout(timeout))
    void Promise.resolve()
      .then(cleanup)
      .catch((error) => console.error(error))
      .finally(() => {
        // Leave the native before-quit callback before requesting quit again.
        setImmediate(() => app.quit())
      })
  })
}
