/**
 * Lambda function that executes standard, a static file linter.
 */
const tar = require('tar')
const zlib = require('zlib')
const tmp = require('tmp')
const fs = require('fs')
const exec = require('child_process').exec
const AWS = require('aws-sdk')
const jwt = require('jsonwebtoken')
const GitHubApi = require('github')
const request = require('request')

const github = new GitHubApi()
const CMD = 'standard'
const FULL_CMD = '/var/task/node_modules/standard/bin/cmd.js'
const BUCKET = process.env.BUCKET
const PEM = process.env.PEM
const INTEGRATION_ID = process.env.INTEGRATION_ID
const STANDARD = 'JavaScript Standard Style'

function getHook (event) {
  return JSON.parse(event['Records'][0]['Sns']['Message'])
}

function getToken (installationId, callback) {
  'use strict'
  let now = Math.round((new Date()).getTime() / 1000)
  let exp = 300
  let payload = {
    // issued at time
    'iat': now,
    // JWT expiration time
    'exp': now + exp,
    // Integration's GitHub identifier
    'iss': INTEGRATION_ID
  }
  let bearer = jwt.sign(payload, PEM, {algorithm: 'RS256'})
  github.authenticate({
    type: 'integration',
    token: bearer
  })
  github.integrations.createInstallationToken({installation_id: installationId}, (err, res) => {
    if (err) {
      console.error(err)
      return
    }
    callback(res.data.token)
  })
}

function runProcess (owner, repo, sha, codePath, token) {
  github.authenticate({
    type: 'token',
    token: token
  })
  let statusOptions = {
    owner: owner,
    repo: repo,
    sha: sha,
    state: 'pending',
    context: STANDARD
  }
  github.repos.createStatus(statusOptions)
  exec(FULL_CMD, {
    cwd: codePath
  }, (error, stdout, stderr) => {
    let s3 = new AWS.S3()
    let key = `${CMD}/${owner}/${repo}/${sha}.log`
    let params = {
      Bucket: BUCKET,
      Key: key,
      Body: stdout + stderr,
      ACL: 'public-read',
      ContentType: 'text/plain'
    }
    s3.putObject(params, (err, data) => {
      if (err) console.error(err, err.stack)
    })
    statusOptions.target_url = `https://${BUCKET}.s3.amazonaws.com/${key}`
    if (error) {
      statusOptions.state = 'failure'
      statusOptions.description = `${CMD} failed!`
    } else {
      statusOptions.state = 'success'
      statusOptions.description = `${CMD} succeeded!`
    }
    github.repos.createStatus(statusOptions)
  })
}

function downloadCode (owner, repo, sha, token) {
  let options = {
    url: `https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`,
    headers: {
      'Authorization': `token ${token}`,
      'User-Agent': 'request'
    },
    followAllRedirects: true
  }
  tmp.dir((err, path, cleanupCallback) => {
    if (err) {
      console.error(err)
      return
    }
    request.get(options).on('error', console.error)
      .pipe(zlib.Unzip()).on('error', console.error)
      .pipe(tar.x({path: path})).on('error', console.error)
      .on('end', () => {
        fs.readdir(path, (err, files) => {
          if (err) {
            console.error(err)
            return
          }
          runProcess(owner, repo, sha, `${path}/${files[0]}`, token)
        })
      })
  })
}

function parseHook (hook) {
  let repo = hook['repository']['name']
  let owner = hook['repository']['owner']['login']
  let sha
  // Hooks is push event
  if ('head_commit' in hook) {
    sha = hook['head_commit']['id']
  } else {
    // Hook is pull request event
    let codeHasChanged = hook['action'] in ['opened', 'edited', 'reopened']
    let isOwner = hook['pull_request']['user']['login'] === owner
    if (codeHasChanged && !isOwner) {
      sha = hook['pull_request']['head']['sha']
    }
  }
  return [owner, repo, sha]
}

exports.handle = (e, ctx, cb) => {
  let hook = getHook(e)
  let [owner, repo, sha] = parseHook(hook)
  if (sha === undefined) return
  let installationId = hook['installation']['id']
  getToken(installationId, (token) => { downloadCode(owner, repo, sha, token) })
}

