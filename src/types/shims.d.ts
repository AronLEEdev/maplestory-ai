declare module 'screenshot-desktop' {
  interface ScreenshotOptions {
    format?: 'png' | 'jpg'
    screen?: string
  }
  function screenshot(opts?: ScreenshotOptions): Promise<Buffer>
  export default screenshot
}
