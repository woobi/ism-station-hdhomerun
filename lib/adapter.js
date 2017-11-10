/**
 * library adapter
 *
 * ####Example:
 *
 * @param {Instance} Parent
 * @param {Object} opts
 * @param {Function} callback
 * @api public
 */

var debug = require('debug')('ism-station-hdhomerun:adapter');
var _ = require('lodash');
var Promise = require('bluebird');

var Adapter = function ( config ) {
	if ( !( this instanceof Adapter ) ) return new Adapter( config );
	
	//debug('Adapter', config);
	// adapter methods
	
	if ( _.isFunction( config.adapter ) ) {
		this.adapter = config.adapter( config.adapterConfig, ( ) => {});
	} else {
		this.adapter = {};
	}
	
	const methods = config.methods ?
		config.methods
	:
		['socketConnect', 'dbConnect', 'connect', 'connection', 'endSession', 'getTVChannels', 'getChannelGroups', 'getGuideData', 'getGuideProgram', 'setTimer', 'getTimers', 'getSeriesTimers', 'deleteTimer', 'deleteSeriesTimer', 'getRecordings', 'deleteRecording', 'movieByName', 'movieByIMDB', 'movie', 'movieFromTMDB', 'movieByTMDB','movies', 'tvShow', 'tvShows', 'recentMovies', 'tvShowEpisodes', 'tvShowByIMDB', 'tvShowFromTVDB', 'tvShowByTVDB', 'tvShowByName', 'mediaFile', 'mediaFiles', 'recentEpisodes', 'openTuner'];
		
	methods.forEach( method => {
		this[method] = ( obj = {} ) => {
			if ( _.isFunction( this.adapter[method] ) ) {
				return this.adapter[method]( obj );
			} else {
				debug( method + ' adapter function is missing!' );
				return Promise.reject(method + ' adapter function is missing!');
			}
		}
	})
		
	return this;
}

module.exports = Adapter;

	
