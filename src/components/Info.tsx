import { useState } from 'react'
export function Info({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative inline-block align-middle">
      <button type="button" aria-label="More info"
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#30363d] text-[10px] font-bold text-dim hover:bg-brandblue hover:text-white transition-colors"
        onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onClick={() => setOpen(o => !o)}>i</button>
      {open && (
        <span role="tooltip" className="absolute left-1/2 top-5 z-50 w-64 -translate-x-1/2 rounded-lg border border-[#30363d] bg-[#1c2128] p-3 text-left text-xs font-normal leading-relaxed text-[#e6edf3] shadow-xl">
          {text}
        </span>
      )}
    </span>
  )
}
