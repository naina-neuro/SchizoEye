// Static-host configuration for Vercel or Netlify.
window.getApiBase = function () {
	return (
		window.SCHIZOEYE_API_BASE ||
		(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
			? 'http://localhost:5000'
			: 'https://schizoeyeclassification.onrender.com')
	).replace(/\/$/, '');
};
window.SCHIZOEYE_API_BASE = window.getApiBase();