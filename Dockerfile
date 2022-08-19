FROM node:lts-buster-slim

# RUN apt-get update && apt-get install -y \
# 	graphicsmagick \
# 	python \
# 	build-essential \
# 	git \
# 	curl

# Create user with the group
RUN useradd --user-group --create-home --shell /bin/bash test

# Create app directory
WORKDIR /srv/test

# Install app dependencies. At this point we don't have volumes mounted
COPY . .
RUN chown -R test:test ./
USER test

ENV HUSKY_SKIP_INSTALL=1
RUN npm install

ENTRYPOINT [ "npm", "run", "build_n_test" ]
