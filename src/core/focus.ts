import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export function matchesPattern(title: string | null, pattern: string): boolean {
  if (!title) return false
  return title.toLowerCase().includes(pattern.toLowerCase())
}

export async function getForegroundWindowTitle(): Promise<string | null> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execAsync(
        `osascript -e 'tell application "System Events" to get name of (process 1 whose frontmost is true)'`,
      )
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
