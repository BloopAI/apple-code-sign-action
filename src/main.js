const core = require('@actions/core')
const exec = require('@actions/exec')
const toolCache = require('@actions/tool-cache')
const os = require('os')

async function mapWithConcurrency(items, concurrency, fn) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer')
  }

  const results = new Array(items.length)
  let nextIndex = 0

  async function worker() {
    for (let index = nextIndex++; index < items.length; index = nextIndex++) {
      results[index] = await fn(items[index], index)
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  )
  await Promise.all(workers)

  return results
}

async function execRcodesign(rcodesign, args) {
  let stdout = ''
  let stderr = ''

  const exitCode = await exec.exec(rcodesign, args, {
    silent: true,
    ignoreReturnCode: true,
    listeners: {
      stdout: data => {
        stdout += data.toString()
      },
      stderr: data => {
        stderr += data.toString()
      }
    }
  })

  return { exitCode, stdout, stderr }
}

async function getRcodesign(version) {
  const platform = os.platform()
  const arch = os.arch()

  let url =
    'https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F'
  url += `${version}/apple-codesign-${version}-`
  let directory = `apple-codesign-${version}-`

  switch (platform) {
    case 'darwin':
      url += 'macos-universal.tar.gz'
      directory += 'macos-universal'
      break

    case 'linux':
      switch (arch) {
        case 'aarch64':
          url += 'aarch64-unknown-linux-musl.tar.gz'
          directory += 'aarch64-unknown-linux-musl'
          break
        case 'x64':
          url += 'x86_64-unknown-linux-musl.tar.gz'
          directory += 'x86_64-unknown-linux-musl'
          break
        default:
          throw new Error(`unsupported Linux architecture: ${arch}`)
      }
      break

    case 'win32':
      if (arch === 'x64') {
        url += 'x86_64-pc-windows-msvc.zip'
        directory += 'x86_64-pc-windows-msvc'
      } else {
        throw new Error(`unsupported Windows architecture: ${arch}`)
      }
      break

    default:
      throw new Error(`unsupported operating system: ${platform}`)
  }

  core.info(`Downloading rcodesign from ${url}`)

  const toolPath = await toolCache.downloadTool(url)

  let destDir

  if (url.endsWith('.tar.gz')) {
    destDir = await toolCache.extractTar(toolPath, 'rcodesign')
  } else {
    destDir = await toolCache.extractZip(toolPath, 'rcodesign')
  }

  let exe = `${destDir}/${directory}/rcodesign`
  if (os.platform === 'win32') {
    exe += '.exe'
  }

  return exe
}

async function run() {
  try {
    const inputPathRaw = core.getInput('input_path', { required: true })
    let inputPaths = core.getMultilineInput('input_path')
    if (inputPaths.length === 1 && inputPaths[0].includes('\n')) {
      inputPaths = inputPaths[0]
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
    }
    if (inputPaths.length === 0) {
      throw new Error('input_path is required')
    }

    const hasMultipleInputPaths = inputPaths.length > 1
    const inputPath = inputPaths[0] || inputPathRaw.trim()
    const outputPath = core.getInput('output_path')
    const sign = core.getBooleanInput('sign')
    const notarize = core.getBooleanInput('notarize')
    const notarizeConcurrencyInput = core.getInput('notarize_concurrency')
    const notarizeConcurrency = parseInt(notarizeConcurrencyInput || '0', 10)
    if (Number.isNaN(notarizeConcurrency) || notarizeConcurrency < 0) {
      throw new Error('notarize_concurrency must be a non-negative integer')
    }

    const staple = core.getBooleanInput('staple')
    const configFiles = core.getMultilineInput('config_file')
    const profile = core.getInput('profile')
    const pemFiles = core.getMultilineInput('pem_file')
    const p12File = core.getInput('p12_file')
    const p12Password = core.getInput('p12_password')
    const certificateDerFiles = core.getMultilineInput('certificate_der_file')
    const remoteSignPublicKey = core.getMultilineInput('remote_sign_public_key')
    const remoteSignPublicKeyPemFile = core.getInput(
      'remote_sign_public_key_pem_file'
    )
    const remoteSignSharedSecret = core.getInput('remote_sign_shared_secret')
    const appStoreConnectApiKeyJsonFile = core.getInput(
      'app_store_connect_api_key_json_file'
    )
    const appStoreConnectApiIssuer = core.getInput(
      'app_store_connect_api_issuer'
    )
    const appStoreConnectApiKey = core.getInput('app_store_connect_api_key')
    const signArgs = core.getMultilineInput('sign_args')
    const rcodesignVersion = core.getInput('rcodesign_version')

    const rcodesign = await getRcodesign(rcodesignVersion)

    let signedPaths = inputPaths
    let signedPath = inputPath

    if (hasMultipleInputPaths && outputPath) {
      throw new Error(
        'output_path cannot be used with multiple input_path values'
      )
    }

    if (sign) {
      if (hasMultipleInputPaths) {
        throw new Error(
          'Multiple input_path values are not supported when sign=true'
        )
      }

      const args = ['sign']

      for (const path of configFiles) {
        args.push('--config-file', path)
      }

      if (profile) {
        args.push('--profile', profile)
      }

      for (const path of pemFiles) {
        args.push('--pem-file', path)
      }
      if (p12File) {
        args.push('--p12-file', p12File)
      }
      if (p12Password) {
        args.push('--p12-password', p12Password)
      }
      for (const path of certificateDerFiles) {
        args.push('--certificate-der-file', path)
      }
      if (remoteSignPublicKey.length > 0) {
        args.push('--remote-public-key', remoteSignPublicKey.join(''))
      }
      if (remoteSignPublicKeyPemFile) {
        args.push('--remote-public-key-pem-file', remoteSignPublicKeyPemFile)
      }
      if (remoteSignSharedSecret) {
        args.push('--remote-shared-secret', remoteSignSharedSecret)
      }

      for (const arg of signArgs) {
        args.push(arg)
      }

      args.push(inputPath)

      if (outputPath) {
        args.push(outputPath)
        signedPath = outputPath
      }

      await exec.exec(rcodesign, args)
      signedPaths = [signedPath]
    }

    let stapled = false

    if (notarize) {
      if (!appStoreConnectApiKeyJsonFile) {
        throw new Error(
          'App Store Connect API Key not defined; cannot notarize'
        )
      }

      const args = ['notary-submit']

      for (const path of configFiles) {
        args.push('--config-file', path)
      }

      if (appStoreConnectApiKeyJsonFile) {
        args.push('--api-key-file', appStoreConnectApiKeyJsonFile)
      }
      if (appStoreConnectApiIssuer) {
        args.push('--api-issuer', appStoreConnectApiIssuer)
      }
      if (appStoreConnectApiKey) {
        args.push('--api-key', appStoreConnectApiKey)
      }

      if (staple) {
        args.push('--staple')
      } else {
        args.push('--wait')
      }

      const concurrency =
        notarizeConcurrency > 0 ? notarizeConcurrency : signedPaths.length

      core.info(`Submitting ${signedPaths.length} file(s) for notarization`)

      const results = await mapWithConcurrency(
        signedPaths,
        concurrency,
        async path => {
          core.info(`Starting notarization: ${path}`)

          const { exitCode, stdout, stderr } = await execRcodesign(rcodesign, [
            ...args,
            path
          ])

          if (exitCode === 0) {
            return { path, ok: true, stdout, stderr }
          }

          return { path, ok: false, exitCode, stdout, stderr }
        }
      )

      const failures = results.filter(r => !r.ok)
      for (const result of results) {
        core.startGroup(
          result.ok
            ? `notary-submit: ${result.path}`
            : `notary-submit failed: ${result.path}`
        )

        if (!result.ok) {
          core.error(`exit code: ${result.exitCode}`)
        }

        if (result.stdout.trim()) {
          if (result.ok) {
            core.info(result.stdout.trim())
          } else {
            core.error(result.stdout.trim())
          }
        }
        if (result.stderr.trim()) {
          if (result.ok) {
            core.info(result.stderr.trim())
          } else {
            core.error(result.stderr.trim())
          }
        }
        core.endGroup()
      }

      if (failures.length > 0) {
        throw new Error(
          `Notarization failed for: ${failures.map(f => f.path).join(', ')}`
        )
      }

      if (staple) {
        stapled = true
      }
    }

    if (staple && !stapled) {
      const args = ['staple']

      for (const path of configFiles) {
        args.push('--config-file', path)
      }

      const concurrency =
        notarizeConcurrency > 0 ? notarizeConcurrency : signedPaths.length

      const results = await mapWithConcurrency(
        signedPaths,
        concurrency,
        async path => {
          core.info(`Stapling notarization ticket: ${path}`)

          const { exitCode, stdout, stderr } = await execRcodesign(rcodesign, [
            ...args,
            path
          ])

          if (exitCode === 0) {
            return { path, ok: true, stdout, stderr }
          }

          return { path, ok: false, exitCode, stdout, stderr }
        }
      )

      const failures = results.filter(r => !r.ok)
      for (const result of results) {
        core.startGroup(
          result.ok ? `staple: ${result.path}` : `staple failed: ${result.path}`
        )

        if (!result.ok) {
          core.error(`exit code: ${result.exitCode}`)
        }

        if (result.stdout.trim()) {
          if (result.ok) {
            core.info(result.stdout.trim())
          } else {
            core.error(result.stdout.trim())
          }
        }
        if (result.stderr.trim()) {
          if (result.ok) {
            core.info(result.stderr.trim())
          } else {
            core.error(result.stderr.trim())
          }
        }
        core.endGroup()
      }

      if (failures.length > 0) {
        throw new Error(
          `Stapling failed for: ${failures.map(f => f.path).join(', ')}`
        )
      }
    }

    core.setOutput('output_path', signedPaths[0])
    core.setOutput('output_paths', signedPaths.join('\n'))
  } catch (error) {
    core.setFailed(error.message)
  }
}

module.exports = {
  run
}
