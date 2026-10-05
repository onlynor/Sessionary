import {
  ArrowDown, ArrowUp, Bot, Check, ChevronDown, ChevronRight, ChevronsUpDown, CircleDot, Copy, Ellipsis, ExternalLink, EyeOff, File, FilePen,
  FilePlus, FileText, Folder, FolderOpen, GitBranch, Globe, Keyboard, Languages, Layers, Lightbulb, ListChecks, ListChevronsDownUp, ListChevronsUpDown, Lock,
  LockOpen, MessageSquare, Monitor, Moon, PanelLeft, PanelLeftOpen, PanelRight, Plus, RefreshCw, Search, Settings2, Sun, Terminal, TextSearch,
  Trash2, User, X, Pin, PinOff, Play, Code, SquareTerminal, ArrowDownWideNarrow, Radio, Clipboard, type LucideIcon,
} from 'lucide-react'

/** One icon vocabulary (lucide). Strokes are absolute, so a 12px and an 18px icon draw the same line weight. */
const ICONS = {
  // tool kinds
  shell: Terminal, read: FileText, edit: FilePen, write: FilePlus, search: Search, web: Globe, task: Bot, todo: ListChecks, other: Plus, think: Lightbulb,
  // ui
  chev: ChevronRight, down: ChevronDown, updown: ChevronsUpDown, folder: Folder, 'folder-open': FolderOpen, file: File, find: TextSearch,
  refresh: RefreshCw, sidebar: PanelLeft, 'sidebar-open': PanelLeftOpen, panel: PanelRight, branch: GitBranch, copy: Copy, layers: Layers,
  expand: ListChevronsUpDown, collapse: ListChevronsDownUp, arrowdown: ArrowDown, arrowup: ArrowUp, keyboard: Keyboard, user: User, trash: Trash2,
  more: Ellipsis, eyeoff: EyeOff, check: Check, x: X, lock: Lock, unlock: LockOpen, settings: Settings2, sun: Sun, moon: Moon, monitor: Monitor,
  dirty: CircleDot, message: MessageSquare, external: ExternalLink, languages: Languages,
  pin: Pin, unpin: PinOff, play: Play, code: Code, terminal: SquareTerminal, sort: ArrowDownWideNarrow, live: Radio, clipboard: Clipboard,
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS

export function Icon({ name, size = 16, stroke = 1.35 }: { name: IconName | string; size?: number; stroke?: number }) {
  const C = ICONS[name as IconName] ?? ICONS.other
  return <C className="icon" size={size} strokeWidth={stroke} absoluteStrokeWidth aria-hidden="true" />
}
