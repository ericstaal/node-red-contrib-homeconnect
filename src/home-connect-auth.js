module.exports = function (RED) {
    const request = require('request');
    const fs = require('fs');

    function OAuth2(config) {
        RED.nodes.createNode(this, config);

        this.name = config.name;
        this.simulation_mode = config.simulation_mode;
        this.client_id = this.credentials.client_id;
        this.client_secret = this.credentials.client_secret;

        this.context().flow.set('homeconnect_simulation', this.simulation_mode);

        this.status({ fill: 'red', shape: 'ring', text: 'unauthorized' });

        const node = this;

        node.getHost = () => {
            return getHost(node.simulation_mode);
        }

        node.getCallbackUrl = (protocol, hostname, port) => {
            return protocol + '//' + hostname + (port ? ':' + port : '') + '/oauth2/auth/callback';
        }

        node.getAuthorizationUrl = (protocol, hostname, port, client_id, callback_url) => {
            node.status({ fill: 'yellow', shape: 'ring', text: 'authorizing...' });

            return node.getHost() + '/security/oauth/authorize' + 
                '?client_id=' + client_id + 
                '&response_type=code&redirect_uri=' + callback_url;
        };

        node.getTokens = (authCode) => {
            request.post({
                headers: {'content-type' : 'application/x-www-form-urlencoded'},
                url: node.getHost() + '/security/oauth/token',
                body: 'client_id=' + node.client_id + 
                    '&client_secret=' + node.client_secret + 
                    '&grant_type=authorization_code&code=' + authCode +
                    '&redirect_uri=' + runningAuth.callback_url
            }, (error, response, body) => {

                if (error || response.statusCode != 200) {
                    node.error('getTokens failed: ' + body);
                    node.status({ fill: 'red', shape:'dot', text: 'getTokens failed' });
                    return;
                }

                node.status({ fill: 'green', shape:'dot', text: 'authorized' });

                node.tokens = { ...JSON.parse(body), timestamp: Date.now() };

                node.writeTokenFile();

                node.send({
                    topic: 'oauth2',
                    payload: {
                        access_token: node.tokens.access_token
                    }
                });
            });
        }

        node.refreshTokens = () => {
            request.post({
                headers: {'content-type' : 'application/x-www-form-urlencoded'},
                url: node.getHost() + '/security/oauth/token',
                body: 'grant_type=refresh_token&client_secret=' + node.client_secret + '&refresh_token=' + node.tokens.refresh_token
            }, (error, response, body) => {
                if (error || response.statusCode != 200) {
                    node.error('refreshTokens failed: ' + body);
                    return;
                }

                node.status({ fill: 'green', shape:'dot', text: 'authorized' });

                node.tokens = { ...JSON.parse(body), timestamp: Date.now() };

                node.writeTokenFile();

                node.send({
                    topic: 'oauth2',
                    payload: {
                        access_token: node.tokens.access_token
                    }
                });
            });
        };

        node.loadTokenFile = () => {
            try {
                let path = RED.settings.userDir + '/homeconnect_tokens.json';
                if (fs.existsSync(path)) {
                    let content = fs.readFileSync(path, 'utf8');
                    node.tokens = JSON.parse(content);
    
                    if (node.tokens != undefined) {
                        node.refreshTokens();
                    }
                }
            } catch (err) {
                node.error(err);
            }
        };

        node.writeTokenFile = () => {
            fs.writeFile(RED.settings.userDir + '/homeconnect_tokens.json', JSON.stringify(node.tokens), (err) => {
                if (err) {
                    node.error(err);
                }
            });
        }

        RED.events.on("nodes-started", () => {
            node.loadTokenFile();
        });
    }
    RED.nodes.registerType('OAuth2', OAuth2, {
        credentials: {
            client_id: { type: 'text' },
            client_secret: { type: 'text' }
        }
    });

    let getHost = (simulation_mode) => {
        if(simulation_mode) {
            return 'https://simulator.home-connect.com';
        } else {
            return 'https://api.home-connect.com';
        }
    }

    let runningAuth = {};

    RED.httpAdmin.get('/oauth2/:id/auth/url', (req, res) => {
        if (!req.query.protocol || !req.query.hostname) {
            res.sendStatus(400);
            return;
        }

        let node = RED.nodes.getNode(req.params.id);
        if (!node) {
            res.sendStatus(404);
            return;
        }

        let client_id = node.client_id;

        runningAuth.node_id = req.params.id;
        runningAuth.callback_url = node.getCallbackUrl(req.query.protocol, req.query.hostname, req.query.port);

        const url = node.getAuthorizationUrl(req.query.protocol, req.query.hostname, req.query.port, client_id, runningAuth.callback_url);
        res.send({
            'url': url
        });
    });

    RED.httpAdmin.get('/oauth2/auth/callback', (req, res) => {
        let node = RED.nodes.getNode(runningAuth.node_id);
        node.getTokens(req.query.code);
        runningAuth = {};
        res.sendStatus(200);
    });
}