import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'

let browser: Browser | null = null

export async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    })
    console.log('🌐 Browser launched')
  }
  return browser
}

export async function newPage(): Promise<Page> {
  const b = await getBrowser()
  const context = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  })
  return context.newPage()
}
