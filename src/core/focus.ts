import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export function matchesPattern(title: string | null, pattern: string): boolean {
  if (!title) return false
  return title.toLowerCase().includes(pattern.toLowerCase())
}

export async function activateApplication(namePattern: string): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      await execAsync(
        `osascript -e 'tell application "System Events" to set frontmost of (first process whose name contains ${JSON.stringify(namePattern)}) to true'`,
      )
    } catch {
      // ignore — window may not be open
    }
  }
  if (process.platform === 'win32') {
    try {
      await execAsync(
        `powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W { [DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\\"user32.dll\\")] public static extern IntPtr FindWindow(string c, string t); }'; $h=[W]::FindWindow($null,'${namePattern}'); if($h -ne 0){[W]::SetForegroundWindow($h)}"`,
      )
    } catch {
      // ignore
    }
  }
}

export async function getForegroundWindowTitle(): Promise<string | null> {
  if (process.platform === 'darwin') {
    // Prefer the front-window's title (e.g. "Henesys - MapleStory Worlds").
    // Fall back to process name when no front window is queryable (some apps
    // — e.g. menu-bar-only — refuse the title query).
    const script = `
      tell application "System Events"
        set frontProc to first process whose frontmost is true
        try
          return (name of front window of frontProc) & " — " & (name of frontProc)
        on error
          return name of frontProc
        end try
      end tell
    `.trim().replace(/\s+/g, ' ')
    try {
      const { stdout } = await execAsync(`osascript -e ${JSON.stringify(script)}`)
      return stdout.trim() || null
    } catch {
      return null
    }
  }
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execAsync(
        `powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W { [DllImport(\\"user32.dll\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\"user32.dll\\")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n); public static string T() { var s = new System.Text.StringBuilder(256); GetWindowText(GetForegroundWindow(), s, 256); return s.ToString(); } }'; [W]::T()"`,
      )
      return stdout.trim() || null
    } catch {
      return null
    }
  }
  return null
}
