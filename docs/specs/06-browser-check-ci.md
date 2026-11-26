# Spec: Wire the browser check into CI

## Problem Statement

The browser check runs 114 checks against the built site, but only when
someone remembers to run it. The deploy workflow gates on type check, unit
tests, and build only, so a UI-only regression ships green.

## Solution

Add a CI job that builds the site, serves it, installs Playwright Chromium,
and runs the browser check on every push and pull request.

## User Stories

1. As a developer pushing a change, I want the browser check to run automatically, so that a UI regression is caught before it ships.
2. As a developer opening a pull request, I want the same check to run, so that review starts from a verified UI.
3. As a developer deploying, I want deploys to stay gated on the browser check, so that a green deploy means the UI was verified.

## Implementation Decisions

- The new job runs on the same runner image as the build job, installs
  dependencies, builds, serves the output folder, installs Playwright
  Chromium, and runs the browser check.
- The deploy job keeps deploying only outside pull requests, unchanged.
- The browser check script itself is not changed.

## Testing Decisions

- The workflow file is validated by parsing it, so a syntax error is caught
  before it is committed.
- The job's behaviour is verified by reading the workflow: it runs on push
  and pull request, and it runs the same command a developer runs locally.

## Out of Scope

- Any change to the browser check script or its checks.
- Any change to the deploy job's permissions or environment.
- Any other workflow.

## Further Notes

- The script already falls back to the cached Chromium binary when the
  package revision does not match the cache, so the CI install step is the
  only new requirement.
