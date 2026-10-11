import type { AnchorHTMLAttributes, MouseEvent } from 'react'
import { navigate } from './router'

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string
}

/** An in-app link: a plain click navigates client-side; modified clicks keep browser behavior. */
export function Link({ href, onClick, ...rest }: LinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event)
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    if (event.defaultPrevented || event.button !== 0 || modified) {
      return
    }
    event.preventDefault()
    navigate(href)
  }

  return <a href={href} onClick={handleClick} {...rest} />
}
