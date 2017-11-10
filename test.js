const hdhr = require('./lib/index');
const debug = require('debug')('ism-station-hdhomerun:test');
const _ = require('lodash');
const EventEmitter = require('events');
const Woobi = require('woobi');
const _Woobi = new Woobi();
_Woobi.init( {
	transition: false,
	host: 'studio.snowpi.org',
	proxy: {
		port: 3777,
		host: '0.0.0.0',
		app: false,
	}
} ).catch( debug );

class Emitter extends EventEmitter {
	 constructor() {
        super();
    }	
    test () {
		this.emit('station:cablecard', 'test');
	}
}

const Gab = new Emitter();
Gab.on('station:cablecard:status', data => {
	debug( 'Status', data );
});
Gab.on('station:cablecard:tune', data => {
	//debug( 'Tune', data );
	//Gab.emit('ism:cablecard:untune', data.tuner.id )
});
Gab.on('station:cablecard:untune', data => {
	//debug( 'unTune', data );
});
const HD = new hdhr()
.init({
	name: 'Cablecard',
	gab: Gab,
	gabPrefix: 'station:cablecard',
	gabTalk: {
		status: 'station:cablecard:status',
		tune: 'station:cablecard:tune',
		untune: 'station:cablecard:untune',
		untuneAll: 'station:cablecard:untuneAll',
		channels: 'station:cablecard:channels',
		epg: 'station:cablecard:epg',		
	},
	gabListen: {
		setConfig: 'ism:cablecard:setConfig',
		getConfig: 'ism:cablecard:getConfig',
		status: 'ism:cablecard:status',
		tune: 'ism:cablecard:tune',
		untune: 'ism:cablecard:untune',
		channels: 'ism:cablecard:channels',
		epg: 'ism:cablecard:epg',
		untuneAll: 'ism:cablecard:untuneAll',
	},
	onlyChannels: [ 502, 501 ],
	primary: '10.2.2.23'
})
.then( station => {
	//console.log(station.channels);
	//station.playlist()
	//.then( list => {
		//console.log(list);
	//})
	//.catch( e => {
	//	console.log(e);
	//});
	debug('groups', Object.keys(station.channels.groups));
	
	//station.Woobi.libs.livetv.endSession();
	// we start our return here and run promises till done
	const name = 'cablecard2';
	return _Woobi.addChannel(name, {
		loop: true,
		noTransition: true,
		out: name + '.ts',
		mpegts: true,
		// hdhomerun will send us a stream here
		assets: [
			{
				type: 'udpSink',
				port: 2001,
				host: '10.2.2.12',
				name: name + '-sink',
				playSource: true,
			},
			{
				type: 'udpStream',
				port: 2000,
				host: '10.2.2.134',
				name: name + 'stream-laptop'
			},
			{
				type: 'udpStream',
				port: 2002,
				host: '10.2.2.12',
				name: name + 'stream-studio'
			},
		],
	})
	.then( Channel => {
		
		const chan = _.find(Channel.udpSinks, ['name', name + '-sink']); 
		//debug(chan)
		//Gab.emit('ism:cablecard:tune', { channel: 724, http: Channel.helpers.request  } )
		Gab.emit('ism:cablecard:untuneAll', {});
		Gab.once('station:cablecard:untuneAll', () => {
			debug('Tune');
			Gab.emit('ism:cablecard:tune', { channel: 724, delivery: { udp: chan.link, http: Channel.helpers.request }  } )
		});
		
		return;
	})
})
.then( station => {
	return;
})
.catch(debug);


