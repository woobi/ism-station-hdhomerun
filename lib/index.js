/**
* Intranet Station Manager
* hdhomerun station
* 
* */
/*
* TODO
* proper guide data plugin
* group channels by station name across devices for tuning
*/
const device = require('hdhomerun');
const Promise = require('bluebird');
const async = require('async');
const fs = require('fs');
const _ = require('lodash');
const request = require('request-promise');
const Woobi = require('woobi');
const moment = require('moment');
const debug = require('debug')('ism-station-hdhomerun:index');
const Adapter = require('./adapter');

Promise.promisifyAll(device, { 
	suffix: 'Promise',
	filter: function(name) {
		return ['discover', 'create'].indexOf(name) > -1;
	},
});

const Hdhr = class HDHR {

    constructor ( ) {
		this._devices = []; // collection of each device
		this._tuners = {}; // collection of tuners by id
		this._channels = {} // collection of channels to tune by group
		this._channelMap = {} // collection by generated channelId
		this._groupedByName = {} // collection with guideName: [ { tunerid, priority  } ]
		this._available = []; // map of tuner ids
		this._tuned = []; // map of tuner ids
		
		this.delivery = 'udp';
		this.acceptedDelivery = ['udp', 'http'];
		
		return this;
    }
	
	init ( opts ) {
		if ( _.isObject( opts ) )  {
			this.setConfig( opts );
		}	
		return this.addTuners( opts.tuners ).then( res => {
			this._poll = setInterval( this.pollDevices.bind(this), 15000);
			this.status();
			return this; 
		});
	}
	
	setConfig ( opts ) {
		this.name = opts.name || this.name || 'hdhr';
		this.primary = opts.primary || this.primary || false;
		this.delivery = opts.delivery || this.delivery;
		this.acceptedDelivery = opts.acceptedDelivery || this.acceptedDelivery;
        
        this._paths = {
			channels: opts.channelListPath || this.channelListPath || '/lineup.json?show=unprotected',
		}
		this._onlyChannels = opts.onlyChannels || this.onlyChannels || false;
		if ( opts.epgConfig ) {
			this._Woobi = new Woobi();
			this._Woobi.init( opts.epgConfig ).catch( debug );
		}
		
		this.gab = opts.gab || this.gab || false;
		this.gabListen = opts.gabListen || this.gabListen || false;
		this.gabTalk = opts.gabTalk || this.gabTalk || false;
		// function to return a listen for each event sent from master server
		this.gabListeners = ( event  ) => {
			const ret = ( data ) => {
				// check for a function to run or just pass
				if ( _.isFunction( this[event] ) ) {
					this[event]( data ).catch( debug );
				}
			}
			return ret;
		};				
		// Loop through gabListen and add a listener for each
		if ( this.gab && this.gabListen ) {
			_.each( opts.gabListen, ( listen, key ) => {
				 //debug(' Add a listener for ', key, ' on ', listen );
				 this.gab.removeAllListeners( listen );
				 this.gab.on( listen, this.gabListeners( key ) );
			});
		}
		
		if ( _.isFunction( opts.adapter ) ) {
			this.Adapter = Adapter.call( this, opts );
		}
		
		return Promise.resolve( this );
	}
	
	getConfig ( ) {
		return Promise.resolve({
			delivery: this.delivery,
			acceptedDelivery: this.acceptedDelivery,
			cfg: {
				primary: this.primary || '',
				onlyChannels: this.onlyChannels || [],
				name: this.name || '',
				gab: this.gab ? true : false,
				gabTalk: this.gabTalk || {},
				gabListen: this.gabListen || {},
			}
		});
	}
	
	get station ( ) {
		return this.name;
	}
	
	get channels ( ) {
		return this._channels;
	}
	
	get tuners ( ) {
		return { 
			tuners: {
				available: this._available.length,
				tuned: this._tuned.length
			},
			tuned: this._tuned.map( k => {
				const t = this._tuners[k];
				return { id: t.id, channel: t.channel, tuner: t.tuner, device: t.device, channelName: t.channelName } 
			} ),
			available: this._available.map( k => {
				const t = this._tuners[k];
				return { id: t.id, tuner: t.tuner, device: t.device } 
			} ),
		}
	}
	
	get numberOfTuners ( ) {
		return _.reduce(this._devices, ( a, b ) => {
			return a + b.tuners;
		}, 0);
	}
	
	status ( ) {
		
		if ( this.gab ) {
			this.notify( this.gabTalk.status, this.tuners);
		}
		return Promise.resolve( this.tuners );
		
	}
	
	notify ( emitTo, data ) {
		this.gab.emit( emitTo, data );
	}
	
	refreshChannels ( ) {
		return this._refreshChannels( );
	}
	
	pollDevices ( ) {
		// make sure the availables are available
		let p = [];
		let a = [];
		let b = [];
		//debug('Poll Devices', this._available, this._tuned)
		this._available.forEach( ( key ) => ( p.push( getStatus.call( this, key ) ) ) );
		this._tuned.forEach( ( key ) => ( p.push( getStatus.call( this, key ) ) ) );
		
		return Promise.all(p)
		.then(() => {
			this._available = a;
			this._tuned = b;
			//this.status();
		});
		
		function getStatus( key, firstRun = false ) {
			let tuner = this._tuners[key];
			const command = '/' + tuner.tuner + '/vstatus';
			return tuner.control.getPromise(command)
			.then( ( res ) => {
				if ( res ) {
					const channel = Number(res.value.split(' ')[0].split('=')[1]);
					if ( channel !== 0 ) {
						const channelName = res.value.split(' ')[1].split('=')[1];
						tuner.channelName = channelName;
					} else {
						tuner.channelName = ''
					}
					tuner.channel = channel;
					if ( channel === 0) {
						// not in use
						a.push( tuner.id );
						
					} else {
						// in use
						b.push( tuner.id );
					}
				}
				return {};
				//debug( 'Ran check for ', command );
			}).catch(debug);
		}
	}
	
	tune ( { tune, delivery, force = false, seriouslyForce = false }  ) {

		return new Promise( ( resolve, reject ) => {
			// check if we have an available tuner 
			if ( this._available.length === 0 ) {
				return reject({
					success: false,
					code: 503,
					message: 'All tuners are currently in use'
				});	
				
			}
			
			// find the channel and an available tuner
			let channel = false
			const group = this._groupedByName[tune];
			// loop through available and grab the first match
			const tunerId = _.find( this._available, id => {
				const t = this._tuners[id];
				debug('found', t.device, group, tune)
				const a = _.find( group, ['device', t.device] );
				// set the channel number for a virtual channel tune
				if ( a ) {
					
					channel = a.channel;
				}
				return !!a;
			});
			
			if ( !channel ) {
				debug('No channel found');
				return reject({
					success: false,
					code: 503,
					message: 'No virtual channel found to tune'
				});	
			}
			
			let tuner = this._tuners[ tunerId ];
			if ( !tuner ) {
				debug('No tuner found', tunerId);
				return reject({
					success: false,
					code: 503,
					message: 'No available tuners for this channel'
				});	
			}
		
			this._tuned.push( tunerId );
			this._available.splice( this._available.indexOf( tunerId ), 1 );
			
			let run = {
				udp:  ( ) => {
					// now tune the requested channel and send it to the address
					const command = '/' + tuner.tuner + '/vchannel';
					debug('udp', command, channel);
					
					tuner.control.setPromise( command, ''+channel )
					.then( res => tuner.control.setPromise('/' + tuner.tuner + '/target', delivery.udp()) )
					.then( res => tuner.control.getPromise( '/' + tuner.tuner + '/vstatus' ) )
					.then( res => {
						const channelName = res.value.split(' ')[1].split('=')[1];
						tuner.channel = channel;
						tuner.channelName = channelName;
						this.status();
						this.notify( this.gabTalk.tune, {
							success: true,
							channel: channel,
							tuner: { 
								tuner: tuner.tuner,
								device: tuner.device,
								channel: tuner.channel,
								channelName: channelName,
								id: tuner.id
							}
						});
						resolve( tuner );
						return res;
					})
					.catch( e => {
						this._available.push( tunerId );
						this._tuned.splice( this._tuned.indexOf( tunerId ), 1 );
						debug('Error tuning channel', e);
						this.notify( this.gabTalk.tune, {
							success: false,
							channel: channel,
							error: e.message
						});
						reject( {
							success: false,
							code: 503,
							message: 'Could not tune channel'
						} );
					});	
						
					return true;
				},
				callback: ( ) => {
					tuner.control.getPromise( '/' + tuner.tuner + '/vstatus' )
					.then( res => {
						//const channelName = !res.value ? '' : res.value.split(' ')[1].split('=')[1];
						tuner.channel = channel;
						//tuner.channelName = channelName;
						this.status();
						debug('Get http stream', tuner.uri + channel);
						this.notify( this.gabTalk.tune, {
							success: true,
							channel: channel,
							tuner: { 
								tuner: tuner.tuner,
								device: tuner.device,
								channel: tuner.channel,
								//channelName: channelName,
								id: tuner.id
							}
						});
						resolve( tuner );
					})
					.catch( e => {
						this._available.push( tunerId );
						this._tuned.splice( this._tuned.indexOf( tunerId ), 1 );
						reject( {
							success: false,
							code: 503,
							message: 'Request did not return a stream'
						} );
						this.notify( this.gabTalk.tune, {
							success: false,
							channel: channel,
						});
						debug('Error tuning channel', e.message);
					});
				},
				http: ( ) => {
					// grab the http stream
					//debug( delivery.http );
					delivery.http( tuner.uri + channel )
					.then( ( Asset ) => { 
						debug(' got request, now check channel status' ); 
						tuner.end.push( () => {  Asset.end(); return Promise.resolve(); } );
						return Asset;
					})
					.then( res => {
						debug(' get status');
						return tuner.control.getPromise( '/' + tuner.tuner + '/vstatus' ) 
					})
					.then( res => {
						debug(' done with request stream ');
						const channelName = res.value.split(' ')[1].split('=')[1];
						tuner.channel = channel;
						tuner.channelName = channelName;
						this.status();
						debug('Channel Status', tuner.uri + channel, res);
						this.notify( this.gabTalk.tune, {
							success: true,
							channel: channel,
							tuner: { 
								tuner: tuner.tuner,
								device: tuner.device,
								channel: tuner.channel,
								channelName: channelName,
								id: tuner.id
							}
						});
						resolve( tuner );
					})
					.catch( e => {
						this._available.push( tunerId );
						this._tuned.splice( this._tuned.indexOf( tunerId ), 1 );
						reject( {
							success: false,
							code: 503,
							message: 'Request did not return a stream'
						} );
						this.notify( this.gabTalk.tune, {
							success: false,
							channel: channel,
						});
						debug('Error tuning channel', e.message);
					});
				}
			}
			
			run.udp = run.udp.bind(this);
			run.http = run.http.bind(this);
			
			if ( !delivery ) {
				delivery = tuner.via;
			}	
			
			
			// see if our chosen deliver method is available
			if ( this.delivery === 'udp' && delivery.udp ) {
				debug( 'run udp' );
				run.udp();
			} else if ( this.delivery === 'http' && _.isFunction( delivery.http ) ) {
				debug( 'run http' );
				run.http();
			} else if ( _.isFunction( delivery[this.delivery] ) ) {
				debug( 'run custom' );
				delivery[this.delivery]( tuner.uri + channel, run.callback );
			} else {
				reject( {
					success: false,
					code: 503,
					message: 'No delivery method provided'
				});
			}
			
		});
    }
    
    untuneAll ( ) {
		//debug(this._tuned)
		return new Promise( resolve => {
			const tuned = [ ...this._tuned ];
			async.eachSeries(tuned,  ( t, callback ) => {
				// run each tuner and see if we can cancel it
				this.untune( t, true ).then(r => { callback()}).catch(e => {callback(null, e.message)});
			}, (e) => {
				this.notify( this.gabTalk.untuneAll, { success: true, message: e } );
				resolve( this );
			});	
		});
	}
    
    untune ( tuned, force = false ) {
		debug('untune tuner', tuned ,this._tuned);
		return new Promise( ( resolve, reject ) => {
			
			if ( !tuned ) {
				reject( 'Tuner must be supplied' );
				return;
			}		
			// find the tuner
			const tuner1 = this._tuned.indexOf( tuned );
			// if tuned change the channel to none
			if ( tuner1 > -1 ) {
				let tuner = this._tuners[ tuned ];
				Promise.map( tuner.end, ( fn ) => {
					return fn();
				} )
				.then( () => {
					if ( this.delivery === 'udp' ) {
						return tuner.control.setPromise( '/' + tuner.tuner + '/vchannel', 'none');
					}
					return '';
				})
				.then( r => {
					debug('untune channel settings');
					tuner.channel = 0;
					tuner.channelName = '';
					tuner.owned = false;
					this._available.push( tuned );
					this._tuned.splice( tuner1, 1 );
					this.notify( this.gabTalk.untune, {
						success: true,
						channel: 0,
						message: r,
						tuner: { 
							tuner: tuner.tuner,
							device: tuner.device,
							channel: tuner.channel,
							channelName: tuner.channelName,
							id: tuner.id
						}
					});				
					resolve(true);
				}).catch(e => {
					debug( e.message );
					this.notify( this.gabTalk.untune, {
						success: false,
						error: e.message
					});
					reject( e.message );
				})
			} else {
				this.notify( this.gabTalk.untune, {
					success: false,
					error: 404
				});	
				reject( 404 );
			}
		})
    }
	
	addTuners ( tuners ) { 
		// find all the devices
		return device.discoverPromise( )
		.then( res => {				
			let p = []; // promise array
			// loop through each device
			res.forEach( ( dev, k ) => {
				debug('hdhomerun device %s found at %s',
					dev.device_id, dev.device_ip);
				// create a tuner control object for each available tuner
				for ( let i = 0; i < dev.tuner_count; i++ ) {
					const tuner = {
						id: dev.device_id + ':'+i,
						tuner: 'tuner'+i,
						device: dev.device_id,
						uri: 'http://' + dev.device_ip + ':5004/tuner' + i + '/v',
						channel: 0,
						control: device.create(dev),
						owned: false, 
						end: []
					};
					// create promises from device control class
					Promise.promisifyAll(tuner.control, { 
						suffix: 'Promise',
						filter: function(name) {
							return ['get', 'set'].indexOf(name) > -1;
						},
					});
					
					// get tuner status and place each tuner into either tuned or available
					const command = '/' + tuner.tuner + '/vstatus';
					p.push(tuner.control.getPromise(command).then( res => {
						//debug( 'command run for ', device.tuner, res);
						if ( res ) {
							// get the new channel
							const channel = Number(res.value.split(' ')[0].split('=')[1]);
							if ( channel !== 0 ) {
								// if there is a channel get the name too
								const channelName = res.value.split(' ')[1].split('=')[1];
								tuner.channelName = channelName;
							} else {
								tuner.channelName = '';
							}
							tuner.channel = channel;
							// where does this tuner belong
							const who = channel === 0 ? this._available : this._tuned;
							// add the tuner to _available or _tuned
							who.push( tuner.id )
						} else {
							// error so set it to tuned for now
							this._tuned.push( tuner.id );
						}
					}) ); // end push
					
					// add the tuner to the tuners collection
					this._tuners[tuner.id] = tuner;
				}
				
				// create a static entry of the device
				const num = this._devices.push({
					id: dev.device_id,
					ip: dev.device_ip,
					uri: 'http://' + dev.device_ip + '',
					type: dev.device_type,
					tuners: dev.tuner_count,
					primary: ( this.primary == dev.device_ip || this.primary == dev.device_id )				
				});									
			});
			return p;
		})
		.then( p => Promise.all(p) )
		.then( p => this._refreshChannels( ))
	}
	
	_refreshChannels ( ) {
		let p = []; // promise array
		// get the channels from each device with a json request
		this._devices.forEach( device => {
			const options = {
				uri: device.uri + this._paths.channels,
				headers: {
					'User-Agent': 'ism-station-hdhr'
				},
				json: true
			};
			// add each request to the promise array
			p.push(request(options)
				.then( ( channels) => {
					// filter out drm until we can use them
					channels.filter( f => !f.DRM ).forEach( c => {
						const id = device.id + ':' + c.GuideName;
						this._channelMap[id] = {
							name: c.GuideName,
							channel: c.GuideNumber,
							original: c.URL,
							audio: c.AudioCodec,
							video: c.VideoCodec,
							hd: c.HD === 1,
							favorite: c.Favorite === 1,
							id,
							tune: c.GuideNumber
						}
						// add to device group list 
						if ( !this._groupedByName[c.GuideNumber] ) {
							this._groupedByName[c.GuideNumber] = [ { channel: c.GuideNumber, device: device.id, id, primary: device.primary } ];
						} else {
							this._groupedByName[c.GuideNumber].push( { channel: c.GuideNumber, device: device.id, id, primary: device.primary } );
						}
						
					});
					
					return device;
				})
				.catch( e => {
					debug('error in channel request', e.message);
				})
			); //end push
		});
		// run each request promise
		return Promise.all(p)
		.then( ( ) => {
			let channels = []
			// check for a primary device
			let primary = _.find(this._devices, 'primary');
			// build a list of all channels from each device
			// we will filter out repeats later
			Object.keys(this._groupedByName).forEach( k => {
				const group = this._groupedByName[k];
				//debug('group', group );
				// loop through the channels in this group
				if ( primary ) {
					// search for the primary and add this channel if found
					let find = _.find( group, 'primary' );
					//debug('add primary', !!find );
					if ( find ) {
						const chan = this._channelMap[find.id];
						channels.push({
							...chan,
							id: find.channel
						});
					}
				} else {
					// add all the channels
					group.forEach( v => {
						const chan = this._channelMap[v.id];
						//debug('add channel', chan, v)
						channels.push({
							...chan,
							id: v.channel
						});
					});
				}
					
			});
			
			// see if we requested a subset channels instead
			if ( this._onlyChannels ) {
				const only = this._onlyChannels;
				channels = channels.filter( f => ( only.indexOf( Number(f.channel) ) > -1 ) );
			}
			debug(this._onlyChannels, channels.length);
			const guide = ( obj = {} ) => {
				// a promise to add the guide data to the channel entry
				return this.guideByChannel( obj.name, obj.hours || 24 )
				.then( data => {
					obj.guide = data;
					return obj;
				})
				.catch(debug);
			}
			
			let chans = [];
			let guidePromises = []
			// loop through the channels and filter out repeats
			channels.forEach( c => {
				let i = _.findIndex(chans, cc => cc.channel === c.channel);
				if ( i === -1 ) {
					i = chans.push(c);
					// add the guide entry promise to run later
					guidePromises.push( guide( chans[i-1] ) );
				}
			});
			return { chans, guidePromises };
		})
		// make sure the guide promises for each channel are done and build the list
		.then( ( { chans, guidePromises } ) => {
			return Promise.all(guidePromises)
			.then( ( ) => { 
				// channels is a key based object on channel and groups are simple arrays of channel
				this._channels = {
					channels: {},
					groups: {
						all: chans.map( c => c.id),
						hd: chans.filter( f => ( f.hd === true )).map( c => c.id),
						sd: chans.filter( f => ( f.hd !== true )).map( c => c.id),
						favorites: chans.filter( f => ( f.favorite === true )).map( c => c.id),
					}
				}
				//debug(chans)
				// add each channel with channel as key
				chans.forEach( c => {
					this._channels.channels[c.id] = c;
				})
				return this._channels;
			})
		})
		// get any saved channel groups and return the promise
		.then( c => {
			// just return for now
			return this._channels;
			
			if ( !this.Adapter ) { 
				return this._channels;
			}
			return this.Adapter.getChannelGroups()
			.then( groups => {
				_.each( groups, ( g, name ) => {
					this._channels.groups[name] = g.map( c => c.channel );
				});
				return this._channels;
			});
			
		}).catch(debug);
	}
    
    guideByProgram ( program ) {
        return Promise.resolve( true );
    }
	
	guideByChannel ( channels , hours ) {
		if ( !this.Adapter ) { 
			return Promise.resolve( { } );
			//return Promise.reject(new TypeError("EPG is not configured")); 
		}
		
		if ( !Array.isArray( channels ) ) channels = [channels];
		let send = { channels }
		if ( hours ) {
			send.end = moment().add( hours, 'h' ).unix();
			send.start = moment().unix();
		}
		
		return this.Adapter.getGuideData( send )
		.then( data => {
			//console.log(data.guide.length);
			return data.guide;
		})
	}
	
	guideByTime( start, end ) {
		if ( !this.Adapter ) { 
			return Promise.resolve( { } );
		}
		
		const channels = station.channels.channels.map(c => c.channel);
		
		this.Adapter.getGuideData( { start, end, channels } )
		.then( data => {
			//debug(data.guide.length);
			return data.guide;
		})
    }
    
    playlist() {
		
			let list = [ '#EXTM3U'];
			this.channels.channels.forEach( channel => {
				list.push(`#EXTINF:${channel.channel},${channel.channel}: ${channel.name}`);
				list.push(channel.uri);	
			});
			return Promise.resolve( list );
		
	}
}


module.exports = Hdhr;
