.PHONY: check pack install clean

UUID = babysitpr@alexis
DIST = dist
BUNDLE = $(DIST)/$(UUID).shell-extension.zip

check:
	glib-compile-schemas --strict --dry-run schemas
	node --input-type=module --check < extension.js
	node --input-type=module --check < prefs.js
	mkdir -p $(DIST)
	gnome-extensions pack --force --out-dir $(DIST) .

pack: check

install: pack
	gnome-extensions install --force $(BUNDLE)

clean:
	rm -rf $(DIST)
