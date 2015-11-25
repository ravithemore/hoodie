var fs = require('fs')
var path = require('path')
var url = require('url')

var _ = require('lodash')
var Wreck = require('wreck')

exports.register = register
exports.register.attributes = {
  name: 'api',
  dependencies: [
    'h2o2',
    'inert'
  ]
}

var clientPath = path.dirname(require.resolve('hoodie-client/package.json'))

function register (server, options, next) {
  // allow clients to request a gzip response, even if the
  // Accept-Encoding headers is missing or mangled due to
  // faulty proxy servers
  // http://www.stevesouders.com/blog/2010/07/12/velocity-forcing-gzip-compression/
  server.ext('onPreHandler', function maybeForceGzip (request, reply) {
    if (request.query.force_gzip === 'true') {
      request.info.acceptEncoding = 'gzip'
    }
    reply.continue()
  })

  server.route([{
    method: 'GET',
    path: '/{p*}',
    handler: {
      directory: {
        path: options.app.paths.www,
        listing: false,
        index: true
      }
    }
  }, {
    method: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
    path: '/hoodie/{p*}',
    handler: {
      proxy: {
        passThrough: true,
        mapUri: exports.mapProxyPath.bind(null, options.app.db),
        onResponse: exports.addBearerToken
      }
    }
  }, {
    method: 'GET',
    path: '/hoodie/_all_dbs',
    handler: function (request, reply) {
      reply({error: 'not found'}).code(404)
    }
  }, {
    method: 'GET',
    path: '/hoodie/admin/{p*}',
    handler: {
      directory: {
        path: path.dirname(require.resolve('hoodie-admin-dashboard')),
        listing: false,
        index: true
      }
    }
  }, {
    method: 'GET',
    path: '/hoodie/bundle.js',
    handler: {
      file: path.join(clientPath, 'dist/hoodie.js')
    }
  }, {
    method: 'GET',
    path: '/hoodie/bundle.min.js',
    handler: {
      file: path.join(clientPath, 'dist/hoodie.min.js')
    }
  }])

  // serve app for every 404 on an html page
  var indexFile = path.join(options.app.paths.www, 'index.html')
  server.ext('onPostHandler', function (request, reply) {
    var response = request.response

    if (!response.isBoom) return reply.continue()

    var is404 = response.output.statusCode === 404
    var isHTML = /text\/html/.test(request.headers.accept)

    // We only care about 404 for html requests...
    if (!is404 || !isHTML) return reply.continue()

    // Serve index.html
    reply(fs.createReadStream(indexFile))
  })

  return next()
}

exports.addBearerToken = function (err, res, request, reply) {
  if (err) return reply(err).code(500)

  Wreck.read(res, {
    json: true
  }, function (err, data) {
    if (err) return reply(err).code(500)

    if (data &&
      request.method === 'post' &&
      request.path === '/hoodie/_session' &&
      Array.isArray(res.headers['set-cookie'])) {
      var result = /AuthSession=(.*?);/.exec(res.headers['set-cookie'][0])
      if (result && result.length > 1) {
        data.bearerToken = result[1]
      }
      delete res.headers['set-cookie']
    }

    var resp = reply(data).code(res.statusCode).hold()
    resp.headers = res.headers
    resp.send()
  })
}

exports.mapProxyPath = function (db, request, callback) {
  var headers = request.headers
  // use the bearer token as the cookie AuthSession for couchdb:
  delete headers.cookie

  if (headers.authorization && headers.authorization.startsWith('Bearer ')) {
    headers.cookie = 'AuthSession=' + headers.authorization.substring('Bearer '.length)
  }

  // TODO: This is just a temporary fix for PouchDB
  delete headers['accept-encoding']

  headers.host = [db.hostname, db.port].join(':')
  callback(
    null,
    url.resolve(url.format(_.omit(db, 'auth')),
    request.url.path.substr('/hoodie'.length)),
    headers
  )
}