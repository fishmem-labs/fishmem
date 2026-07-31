# Security Policy

## Supported versions

Pre-1.0: only the latest published minor release receives fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Report privately via GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository. You should receive an acknowledgement within 72 hours.

## Scope notes

- The engine, API, dashboard, Desktop app, local IPC/CLI bridge, OAuth/email
  integrations, file-upload pipeline, and document extractor are in scope.
  Desktop bundles signed native runtimes; hosted file extraction runs inside a
  network-disabled container. Reports about signature bypass, tenant or scope
  escape, unsafe file handling, and secret exposure are especially important.
- Treat memory content as untrusted user input in your application: fishmem
  stores and returns user-controlled data and does not make it safe for a
  downstream model. Applications must retain their own prompt-injection and
  tool-authorization boundaries.
