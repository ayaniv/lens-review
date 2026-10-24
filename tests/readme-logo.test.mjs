import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, readText } from './helpers.mjs'

const README = path.join(REPO_ROOT, 'README.md')
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// The logo must be the README's first block, before any heading, so it's the first thing GitHub shows.
// GitHub picks the <source> on its dark theme and falls back to the <img> on light.
function leadingLogo(markdown) {
  const match = markdown.match(/^<p align="center">\s*<picture>([\s\S]*?)<\/picture>\s*<\/p>/)
  if (!match) return null
  const tag = name => match[1].match(new RegExp(`<${name} ([^>]*)>`))?.[1] ?? ''
  const attribute = (tagBody, name) => tagBody.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null
  const source = tag('source')
  const img = tag('img')
  return {
    darkMedia: attribute(source, 'media'),
    darkSrc: attribute(source, 'srcset'),
    lightSrc: attribute(img, 'src'),
    alt: attribute(img, 'alt'),
  }
}

function assertPng(relativePath) {
  const filePath = path.join(REPO_ROOT, relativePath)
  assert.ok(fs.existsSync(filePath), `${relativePath} should exist`)
  assert.deepEqual(fs.readFileSync(filePath).subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE)
}

describe('README logo', () => {
  test('the README opens with the centered Lens Review logo, with a dark-theme variant', () => {
    const logo = leadingLogo(readText(README))
    assert.ok(logo, 'README should start with a centered <picture> block')
    assert.equal(logo.alt, 'Lens Review')
    assert.equal(logo.darkMedia, '(prefers-color-scheme: dark)')
    assert.notEqual(logo.darkSrc, logo.lightSrc)
    assertPng(logo.lightSrc)
    assertPng(logo.darkSrc)
  })

  test('a README whose logo comes after the heading is not accepted', () => {
    const markdown = '# lens-review\n\n<p align="center"><picture><img src="assets/logo-light.png" alt="Lens Review"></picture></p>\n'
    assert.equal(leadingLogo(markdown), null)
  })
})
