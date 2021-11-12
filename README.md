# Summary

The script analyzes student LinkedIn accounts to figure out the current employment state of the provided users.

## FYI
To avoid LinkedIn accounts to get banned run the script no more than once a day and keep `MAX_NUMBER_OF_PROCESSED_PROFILES_PER_ACCOUNT` environment variable set to 47 user profiles or less.

## Prerequisites

1.  install node.js and yarn
1.  run `yarn install` to install script's dependencies

## How to run the script

1.  copy `env.sample` to `env.local` and edit as necessary
1.  add user profiles you want to analyze to the `data/input.csv` file
1.  run `local.sh` to execute the script
1.  the result of the process will be saved in the `data/output.csv` file
