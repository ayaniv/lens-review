import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, readText } from './helpers.mjs'

const README = path.join(REPO_ROOT, 'README.md')
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// The logo must be the README's first block, before any heading, so it's the first thing GitHub shows.
// The #gh-*-mode-only fragments follow GitHub's own theme setting; a <picture> prefers-color-scheme
// query follows the OS instead, which shows the wrong variant when the two disagree.
const THEME_FRAGMENTS = { light: '#gh-light-mode-only', dark: '#gh-dark-mode-only' }

function leadingLogo(markdown) {
  const match = markdown.match(/^<p align="center">([\s\S]*?)<\/p>/)
  if (!match || /<picture>/.test(match[1])) return null
  const images = [...match[1].matchAll(/<img ([^>]*)>/g)].map(([, tagBody]) => ({
    src: tagBody.match(/src="([^"]*)"/)?.[1] ?? '',
    alt: tagBody.match(/alt="([^"]*)"/)?.[1] ?? null,
  }))
  const variant = theme => images.find(image => image.src.endsWith(THEME_FRAGMENTS[theme]))
  const light = variant('light')
  const dark = variant('dark')
  if (images.length !== 2 || !light || !dark) return null
  const withoutFragment = image => ({ ...image, src: image.src.slice(0, image.src.indexOf('#')) })
  return { light: withoutFragment(light), dark: withoutFragment(dark) }
}

function assertPng(relativePath) {
  const filePath = path.join(REPO_ROOT, relativePath)
  assert.ok(fs.existsSync(filePath), `${relativePath} should exist`)
  assert.deepEqual(fs.readFileSync(filePath).subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE)
}

describe('README logo', () => {
  test('the README opens with the centered Lens Review logo, with a dark-theme variant', () => {
    const logo = leadingLogo(readText(README))
    assert.ok(logo, 'README should start with a centered block holding one light-mode and one dark-mode logo')
    for (const image of [logo.light, logo.dark]) {
      assert.equal(image.alt, 'Lens Review')
      assertPng(image.src)
    }
    assert.notEqual(logo.light.src, logo.dark.src)
  })

  test('a README whose logo comes after the heading is not accepted', () => {
    const markdown = '# lens-review\n\n<p align="center"><img src="assets/logo-light.png#gh-light-mode-only" alt="Lens Review"><img src="assets/logo-dark.png#gh-dark-mode-only" alt="Lens Review"></p>\n'
    assert.equal(leadingLogo(markdown), null)
  })

  test('a logo switched by an OS-level prefers-color-scheme <picture> is not accepted', () => {
    const markdown = '<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png"><img src="assets/logo-light.png" alt="Lens Review"></picture></p>\n'
    assert.equal(leadingLogo(markdown), null)
  })
})
